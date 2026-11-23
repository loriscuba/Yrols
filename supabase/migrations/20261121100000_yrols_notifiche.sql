-- Notifiche: la campanella in alto a destra e le notifiche push sul cellulare.
-- Le novità nascono da trigger sulle tabelle che già si riempiono da sole (banche, fondi, Scalable, fondo pensione,
-- offerte Risparmio): nessun programma esterno da cambiare. Ogni novità finisce in yrols.notifications; dopo il commit
-- un trigger chiama la Edge Function yrols-push (pg_net), che le spedisce ai dispositivi iscritti (Web Push, VAPID).
-- Le chiavi VAPID e il gettone del trigger stanno in yrols.push_config, leggibile solo da service_role: nessun secret
-- da configurare a mano, niente nel repo pubblico.

-- ───────────────────────── Tabelle ─────────────────────────
create table yrols.notifications (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('movimento', 'portafoglio', 'offerta')),
  title text not null,
  body text,
  url text check (url is null or url ~ '^/[a-z0-9/_-]*$'),   -- pagina dell'app da aprire, es. /banche
  dedup text unique,                                          -- evita doppioni (stesso movimento, stesso giorno…)
  created_at timestamptz not null default now(),
  read_at timestamptz,
  pushed_at timestamptz
);
create index notifications_recent on yrols.notifications (created_at desc);

create table yrols.push_subscriptions (
  endpoint text primary key check (endpoint ~ '^https://'),
  p256dh text not null,
  auth text not null,
  kinds text[] not null default array['movimento', 'portafoglio', 'offerta'],
  device text,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz,
  failures int not null default 0
);

create table yrols.push_config (
  id int primary key default 1 check (id = 1),
  vapid_public text,
  vapid_private jsonb,
  hook_url text,
  hook_token text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  last_kick_at timestamptz
);
insert into yrols.push_config (hook_url) values ('https://exchjppslwhbnbzuhfqs.supabase.co/functions/v1/yrols-push');

alter table yrols.notifications enable row level security;
alter table yrols.push_subscriptions enable row level security;
alter table yrols.push_config enable row level security;
revoke all on yrols.notifications, yrols.push_subscriptions, yrols.push_config from anon, authenticated;
create policy "solo proprietario" on yrols.notifications for select to authenticated using (yrols.yrols_is_member());
create policy "solo proprietario: letta" on yrols.notifications for update to authenticated
  using (yrols.yrols_is_member()) with check (yrols.yrols_is_member());
create policy "solo proprietario" on yrols.push_subscriptions for all to authenticated
  using (yrols.yrols_is_member()) with check (yrols.yrols_is_member());
grant select on yrols.notifications to authenticated;
grant update (read_at) on yrols.notifications to authenticated;
grant select, insert, update, delete on yrols.push_subscriptions to authenticated;
grant all on yrols.notifications, yrols.push_subscriptions, yrols.push_config to service_role;
grant usage, select on all sequences in schema yrols to service_role;

-- ───────────────────────── Funzioni di appoggio ─────────────────────────
-- Importo all'italiana: 1.234,56 €
create function yrols.yrols_eur(v numeric) returns text
language sql immutable set search_path = '' as $$
  select case when v is null then '' else
    case when v < 0 then '−' else '' end || translate(to_char(abs(v), 'FM999,999,990.00'), ',.', '.,') || ' €' end
$$;

create function yrols.yrols_eur_delta(v numeric) returns text
language sql immutable set search_path = '' as $$
  select case when v is null or v = 0 then '' when v > 0 then ' (+' || yrols.yrols_eur(v) || ')' else ' (' || yrols.yrols_eur(v) || ')' end
$$;

create function yrols.yrols_notify(k text, t text, b text, u text, d text) returns void
language sql security definer set search_path = '' as $$
  insert into yrols.notifications (kind, title, body, url, dedup) values (k, t, b, u, d) on conflict (dedup) do nothing
$$;

-- ───────────────────────── Sorgenti delle novità ─────────────────────────
-- Movimenti nuovi degli ultimi 4 giorni (un collegamento nuovo non riversa tutto lo storico). Un movimento "in attesa"
-- che poi viene contabilizzato con un altro id non si notifica due volte: stesso conto, importo e testo entro 7 giorni.
create function yrols.yrols_notify_tx() returns trigger
language plpgsql security definer set search_path = '' as $$
declare bank text; label text;
begin
  if new.booking_date < current_date - 4 then return null; end if;
  select coalesce(bank_name, name) into bank from yrols.bank_accounts where id = new.account_id;
  label := left(coalesce(nullif(trim(new.counterparty), ''), nullif(trim(new.description), ''), 'Movimento'), 80);
  if exists (select 1 from yrols.notifications where kind = 'movimento' and created_at > now() - interval '7 days'
             and dedup like 'tx:' || new.account_id || ':' || new.amount::text || ':' || md5(label) || ':%') then
    return null;
  end if;
  perform yrols.yrols_notify('movimento',
    case when new.amount < 0 then 'Uscita ' else 'Entrata ' end || yrols.yrols_eur(abs(new.amount)),
    label || coalesce(' · ' || bank, '') || case when new.status = 'PDNG' then ' · in attesa' else '' end,
    '/banche', 'tx:' || new.account_id || ':' || new.amount::text || ':' || md5(label) || ':' || new.id);
  return null;
end $$;
create trigger bank_transactions_notify after insert on yrols.bank_transactions
  for each row execute function yrols.yrols_notify_tx();

-- Fondo PAC: nuovo NAV pubblicato.
create function yrols.yrols_notify_fund() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v numeric; old_v numeric;
begin
  if new.last_nav is null or new.last_nav_date is not distinct from old.last_nav_date then return null; end if;
  v := round(new.quantity * new.last_nav, 2);
  old_v := round(old.quantity * old.last_nav, 2);
  perform yrols.yrols_notify('portafoglio', new.name || ' aggiornato',
    'Valore ' || yrols.yrols_eur(v) || case when new.quantity = old.quantity then yrols.yrols_eur_delta(v - old_v) else '' end
      || ' · NAV del ' || to_char(new.last_nav_date, 'DD/MM'),
    '/banche', 'fondo:' || new.id || ':' || new.last_nav_date);
  return null;
end $$;
create trigger funds_notify after update on yrols.funds for each row execute function yrols.yrols_notify_fund();

-- Scalable: una notifica al giorno al primo aggiornamento, col valore totale e la variazione dal giorno prima.
create function yrols.yrols_notify_scalable() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v numeric; prev numeric; today date := (now() at time zone 'Europe/Rome')::date;
begin
  if new.last_sync_at is null or new.last_sync_at is not distinct from old.last_sync_at then return null; end if;
  select sum(b.amount) into v from yrols.bank_accounts a
    cross join lateral (select amount from yrols.bank_balances where account_id = a.id order by date desc, yrols.yrols_balance_rank(type) limit 1) b
    where a.source = 'scalable';
  select sum(b.amount) into prev from yrols.bank_accounts a
    cross join lateral (select amount from yrols.bank_balances where account_id = a.id and date < today order by date desc, yrols.yrols_balance_rank(type) limit 1) b
    where a.source = 'scalable';
  if v is null then return null; end if;
  perform yrols.yrols_notify('portafoglio', 'Scalable aggiornato',
    'Valore ' || yrols.yrols_eur(v) || yrols.yrols_eur_delta(v - prev), '/banche', 'scalable:' || today);
  return null;
end $$;
create trigger scalable_auth_notify after update on yrols.scalable_auth for each row execute function yrols.yrols_notify_scalable();

-- Fondo pensione: nuovo totale (Excel o PDF caricati).
create function yrols.yrols_notify_pension() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.total is null then return null; end if;
  if tg_op = 'UPDATE' and new.total is not distinct from old.total and new.paid is not distinct from old.paid then return null; end if;
  perform yrols.yrols_notify('portafoglio', 'Fondo pensione aggiornato',
    'Totale ' || yrols.yrols_eur(new.total) || case when tg_op = 'UPDATE' then yrols.yrols_eur_delta(new.total - old.total) else '' end
      || case when new.estimated then ' (stima)' else '' end,
    '/fondo-pensione', 'pensione:' || new.id || ':' || new.total::text || ':' || new.paid::text);
  return null;
end $$;
create trigger pension_funds_notify after insert or update on yrols.pension_funds for each row execute function yrols.yrols_notify_pension();

-- Risparmio: offerta nuova (o scesa di prezzo) che costa meno di quanto si spende oggi.
create function yrols.yrols_notify_offer() returns trigger
language plpgsql security definer set search_path = '' as $$
declare price numeric := coalesce(new.regular_cost, new.monthly_cost);
begin
  if new.status <> 'nuova' or not new.active or new.current_monthly is null or price >= new.current_monthly then return null; end if;
  if tg_op = 'UPDATE' and old.status = 'nuova' then return null; end if;
  perform yrols.yrols_notify('offerta', 'Nuova offerta ' || new.category || ': ' || new.provider,
    new.name || ' a ' || yrols.yrols_eur(new.monthly_cost) || '/mese · risparmi ' || yrols.yrols_eur(new.current_monthly - price) || '/mese',
    '/risparmio', 'offerta:' || new.id || ':' || price::text);
  return null;
end $$;
create trigger saving_offers_notify after insert or update of status on yrols.saving_offers
  for each row execute function yrols.yrols_notify_offer();

-- ───────────────────────── Invio push ─────────────────────────
-- Una sola chiamata a yrols-push per transazione (una sincronizzazione può creare molte notifiche): parte dopo il commit.
create function yrols.yrols_push_kick() returns trigger
language plpgsql security definer set search_path = '' as $$
declare u text; tok text;
begin
  if not exists (select 1 from yrols.push_subscriptions) then return null; end if;
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then return null; end if;
  update yrols.push_config set last_kick_at = now()
    where id = 1 and hook_url is not null and last_kick_at is distinct from now()
    returning hook_url, hook_token into u, tok;
  if u is null then return null; end if;
  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 10000)'
    using u, '{"action":"send"}'::jsonb, jsonb_build_object('Content-Type', 'application/json', 'x-yrols-hook', tok);
  return null;
end $$;
create trigger notifications_push after insert on yrols.notifications for each statement execute function yrols.yrols_push_kick();

-- Chiamata dalla Edge Function: prende le notifiche da spedire (recenti) e le segna, così due invii non si sovrappongono.
create function yrols.yrols_push_claim() returns setof yrols.notifications
language sql security definer set search_path = '' as $$
  update yrols.notifications set pushed_at = now()
    where pushed_at is null and created_at > now() - interval '1 day'
    returning *
$$;

-- Segna lette tutte le notifiche (apertura della campanella).
create function yrols.yrols_notifications_read() returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if not yrols.yrols_is_member() then raise exception 'Accesso non autorizzato' using errcode = '42501'; end if;
  update yrols.notifications set read_at = now() where read_at is null;
  get diagnostics n = row_count;
  return n;
end $$;

revoke execute on function yrols.yrols_eur(numeric), yrols.yrols_eur_delta(numeric), yrols.yrols_notify(text, text, text, text, text),
  yrols.yrols_push_claim(), yrols.yrols_notifications_read() from public, anon, authenticated;
grant execute on function yrols.yrols_push_claim() to service_role;
grant execute on function yrols.yrols_notifications_read() to authenticated;
