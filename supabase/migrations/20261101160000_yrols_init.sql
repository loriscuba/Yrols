-- Yrols: schema del cruscotto su Supabase.
-- Accesso: solo gli utenti presenti in yrols_members (il primo che si registra diventa proprietario).
-- La sincronizzazione bancaria (connettore) e la lettura email (GitHub Actions) usano la service_role.

-- ───────────────────────── Accesso ─────────────────────────
create table public.yrols_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.yrols_members enable row level security;
create policy "membri: vedo me stesso" on public.yrols_members for select to authenticated using (user_id = auth.uid());

create function public.yrols_is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.yrols_members where user_id = auth.uid())
$$;

-- Il primo utente autenticato che chiama questa funzione diventa proprietario. Dopo, nessun altro.
create function public.yrols_claim() returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then return false; end if;
  lock table public.yrols_members in exclusive mode;
  if not exists (select 1 from public.yrols_members) then
    insert into public.yrols_members (user_id) values (auth.uid());
  end if;
  return exists (select 1 from public.yrols_members where user_id = auth.uid());
end $$;

-- ───────────────────────── Banche ─────────────────────────
create table public.bank_connections (
  id text primary key,
  bank_name text,
  country text,
  valid_until timestamptz,
  status text,
  updated_at timestamptz not null default now()
);
create table public.bank_accounts (
  id text primary key,
  connection_id text,
  bank_name text,
  name text,
  iban text,
  currency text not null default 'EUR',
  source text,
  updated_at timestamptz not null default now()
);
create table public.bank_balances (
  account_id text not null references public.bank_accounts(id) on delete cascade,
  type text not null,
  date date not null,
  amount numeric(14,2) not null,
  currency text not null default 'EUR',
  primary key (account_id, type, date)
);
create table public.bank_transactions (
  account_id text not null references public.bank_accounts(id) on delete cascade,
  id text not null,
  amount numeric(14,2) not null,
  currency text not null default 'EUR',
  booking_date date not null,
  value_date date,
  description text,
  counterparty text,
  status text not null default 'BOOK',
  primary key (account_id, id)
);
create index bank_transactions_date on public.bank_transactions (booking_date desc);
create table public.bank_syncs (
  id bigint generated always as identity primary key,
  source text,
  synced_at timestamptz not null,
  received_at timestamptz not null default now(),
  summary jsonb
);

-- ───────────────────────── Casa ─────────────────────────
create table public.bills (
  id bigint generated always as identity primary key,
  provider text not null check (length(trim(provider)) > 0),
  kind text not null default 'altro' check (kind in ('luce','gas','acqua','internet','telefono','rifiuti','condominio','affitto','mutuo','altro')),
  amount numeric(12,2) not null,
  due_date date not null,
  period_from date,
  period_to date,
  paid_at date,
  notes text,
  created_at timestamptz not null default now()
);
create table public.deadlines (
  id bigint generated always as identity primary key,
  title text not null check (length(trim(title)) > 0),
  category text not null default 'altro' check (category in ('casa','auto','tasse','assicurazione','salute','documenti','abbonamenti','scuola','altro')),
  due_date date not null,
  amount numeric(12,2),
  recurrence text not null default 'none' check (recurrence in ('none','monthly','bimonthly','quarterly','semiannual','yearly')),
  done_at date,
  notes text,
  created_at timestamptz not null default now()
);
create table public.reminders (
  id bigint generated always as identity primary key,
  text text not null check (length(trim(text)) > 0),
  remind_at timestamptz,
  priority text not null default 'normale' check (priority in ('bassa','normale','alta')),
  done_at timestamptz,
  created_at timestamptz not null default now()
);
create table public.email_suggestions (
  id bigint generated always as identity primary key,
  message_id text not null unique,
  sender text,
  subject text,
  received_at timestamptz,
  kind text not null check (kind in ('bill','deadline')),
  provider text,
  bill_kind text,
  title text,
  amount numeric(12,2),
  due_date date,
  snippet text,
  status text not null default 'pending' check (status in ('pending','accepted','dismissed')),
  created_id bigint,
  created_at timestamptz not null default now()
);

-- Una scadenza ricorrente completata genera la successiva (fine mese gestita da Postgres: 31/1 + 1 mese = 28/2).
create function public.yrols_next_deadline() returns trigger
language plpgsql set search_path = '' as $$
declare months int;
begin
  if old.done_at is null and new.done_at is not null and new.recurrence <> 'none' then
    months := case new.recurrence when 'monthly' then 1 when 'bimonthly' then 2 when 'quarterly' then 3
                                  when 'semiannual' then 6 when 'yearly' then 12 end;
    insert into public.deadlines (title, category, due_date, amount, recurrence, notes)
    values (new.title, new.category, (new.due_date + make_interval(months => months))::date, new.amount, new.recurrence, new.notes);
  end if;
  return new;
end $$;
create trigger deadlines_next after update of done_at on public.deadlines
  for each row execute function public.yrols_next_deadline();

-- ───────────────────────── Sicurezza (RLS) ─────────────────────────
do $$
declare t text;
begin
  foreach t in array array['bank_connections','bank_accounts','bank_balances','bank_transactions','bank_syncs',
                           'bills','deadlines','reminders','email_suggestions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('create policy "solo proprietario" on public.%I for all to authenticated using (public.yrols_is_member()) with check (public.yrols_is_member())', t);
  end loop;
end $$;
revoke all on public.yrols_members from anon;

-- ───────────────────────── Letture per il cruscotto ─────────────────────────
-- Priorità saldo: ITAV > CLAV > XPCD > CLBD > altri.
create function public.yrols_balance_rank(t text) returns int language sql immutable as $$
  select case t when 'ITAV' then 0 when 'CLAV' then 1 when 'XPCD' then 2 when 'CLBD' then 3 else 4 end
$$;

create view public.yrols_accounts with (security_invoker = true) as
  select a.id, a.name, a.bank_name as "bankName", a.iban, a.currency, a.connection_id as "connectionId",
         a.updated_at as "updatedAt", b.amount::float8 as balance, b.type as "balanceType", b.date as "balanceDate"
  from public.bank_accounts a
  left join lateral (
    select amount, type, date from public.bank_balances bb where bb.account_id = a.id
    order by date desc, public.yrols_balance_rank(type) limit 1
  ) b on true;

create view public.yrols_transactions with (security_invoker = true) as
  select t.id, t.account_id as "accountId", t.amount::float8 as amount, t.currency, t.booking_date as "bookingDate",
         t.value_date as "valueDate", t.description, t.counterparty, t.status,
         a.name as "accountName", a.bank_name as "bankName"
  from public.bank_transactions t left join public.bank_accounts a on a.id = t.account_id;

create function public.yrols_history(days int default 180) returns jsonb
language sql stable set search_path = '' as $$
  with per_day as (
    select distinct on (account_id, date) account_id, date, amount
    from public.bank_balances order by account_id, date, public.yrols_balance_rank(type)
  ), dates as (select distinct date from per_day),
  totals as (
    select d.date, (select coalesce(sum(x.amount), 0) from (
        select distinct on (p.account_id) p.amount from per_day p where p.date <= d.date
        order by p.account_id, p.date desc) x) as total
    from dates d
  )
  select coalesce(jsonb_agg(jsonb_build_object('date', date, 'total', round(total, 2)::float8) order by date), '[]'::jsonb)
  from totals where date >= current_date - days
$$;

create function public.yrols_overview() returns jsonb
language sql stable set search_path = '' as $$
  with agenda as (
    select 'bill' as type, id::text as id, 'Bolletta ' || provider as title, due_date, amount from public.bills
      where paid_at is null and due_date <= current_date + 30
    union all
    select 'deadline', id::text, title, due_date, amount from public.deadlines
      where done_at is null and due_date <= current_date + 30
    union all
    select 'consent', id, 'Rinnova consenso ' || coalesce(bank_name, 'banca'), valid_until::date, null from public.bank_connections
      where valid_until is not null and valid_until::date <= current_date + 14
  )
  select jsonb_build_object(
    'netWorth', (select coalesce(round(sum(balance)::numeric, 2), 0)::float8 from public.yrols_accounts),
    'accountsCount', (select count(*) from public.bank_accounts),
    'last30', (select jsonb_build_object(
        'income', coalesce(sum(amount) filter (where amount > 0), 0)::float8,
        'expenses', coalesce(-sum(amount) filter (where amount < 0), 0)::float8)
      from public.bank_transactions where booking_date >= current_date - 30 and status = 'BOOK'),
    'monthly', (select coalesce(jsonb_agg(m order by m->>'month'), '[]'::jsonb) from (
        select jsonb_build_object('month', to_char(booking_date, 'YYYY-MM'),
          'income', coalesce(sum(amount) filter (where amount > 0), 0)::float8,
          'expenses', coalesce(-sum(amount) filter (where amount < 0), 0)::float8) m
        from public.bank_transactions
        where booking_date >= date_trunc('month', current_date - 185) and status = 'BOOK'
        group by to_char(booking_date, 'YYYY-MM')) s),
    'billsDueTotal', (select coalesce(sum(amount), 0)::float8 from agenda where type = 'bill'),
    'overdueCount', (select count(*) from agenda where due_date < current_date),
    'agenda', (select coalesce(jsonb_agg(jsonb_build_object('type', type, 'id', id, 'title', title, 'dueDate', due_date,
        'amount', amount::float8, 'overdue', due_date < current_date) order by due_date), '[]'::jsonb) from agenda),
    'reminders', (select coalesce(jsonb_agg(r), '[]'::jsonb) from (
        select jsonb_build_object('id', id, 'text', text, 'remindAt', remind_at, 'priority', priority) r
        from public.reminders where done_at is null
        order by remind_at is null, remind_at, case priority when 'alta' then 0 when 'normale' then 1 else 2 end limit 8) s),
    'billsByKind', (select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'total', total::float8) order by total desc), '[]'::jsonb)
        from (select kind, sum(amount) total from public.bills where due_date >= current_date - 365 group by kind) s),
    'history', public.yrols_history(180),
    'pendingEmail', (select count(*) from public.email_suggestions where status = 'pending')
  )
$$;

-- Conferma di una proposta arrivata via email: crea la bolletta o la scadenza.
create function public.yrols_accept_suggestion(suggestion_id bigint, overrides jsonb default '{}'::jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare s public.email_suggestions; new_id bigint; amt numeric; due date;
begin
  select * into s from public.email_suggestions where id = suggestion_id for update;
  if not found then raise exception 'Proposta non trovata' using errcode = 'P0002'; end if;
  if s.status <> 'pending' then raise exception 'Proposta già gestita' using errcode = 'P0001'; end if;
  amt := coalesce(nullif(replace(overrides->>'amount', ',', '.'), '')::numeric, s.amount);
  due := coalesce(nullif(overrides->>'dueDate', '')::date, s.due_date);
  if due is null then raise exception 'Completa i dati: data di scadenza mancante'; end if;
  if s.kind = 'bill' then
    if amt is null then raise exception 'Completa i dati: importo mancante'; end if;
    insert into public.bills (provider, kind, amount, due_date, notes)
    values (coalesce(nullif(overrides->>'provider', ''), s.provider, 'Fornitore'), coalesce(s.bill_kind, 'altro'), amt, due,
            'Importata da email: ' || coalesce(s.subject, ''))
    returning id into new_id;
  else
    insert into public.deadlines (title, category, amount, due_date, notes)
    values (coalesce(nullif(overrides->>'title', ''), s.title, 'Scadenza'), 'altro', amt, due, 'Importata da email: ' || coalesce(s.subject, ''))
    returning id into new_id;
  end if;
  update public.email_suggestions set status = 'accepted', created_id = new_id where id = s.id;
  return jsonb_build_object('id', new_id);
end $$;

-- ───────────────────────── Sincronizzazione bancaria (contratto v1) ─────────────────────────
-- Bollette pagate: addebito con lo stesso importo, entro 20 giorni, fornitore citato nel movimento.
create function public.yrols_match_bills() returns int
language plpgsql set search_path = '' as $$
declare b record; hit date; n int := 0;
begin
  for b in select id, provider, amount, due_date from public.bills where paid_at is null loop
    select booking_date into hit from public.bank_transactions
      where amount = -abs(b.amount) and abs(booking_date - b.due_date) <= 20
        and lower(coalesce(description, '') || ' ' || coalesce(counterparty, '')) like '%' || lower(split_part(b.provider, ' ', 1)) || '%'
      order by abs(booking_date - b.due_date) limit 1;
    if hit is not null then
      update public.bills set paid_at = hit, notes = trim(coalesce(notes, '') || ' [pagata: addebito trovato in banca]') where id = b.id;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

create function public.yrols_bank_sync(payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  src text := payload->>'source';
  synced timestamptz := coalesce((payload->>'syncedAt')::timestamptz, now());
  x jsonb; i int; c int := 0; a int := 0; b int := 0; t int := 0; matched int;
begin
  for x in select * from jsonb_array_elements(coalesce(payload->'connections', '[]')) loop
    if coalesce(x->>'id', '') = '' then raise exception 'connections[%].id obbligatorio', c; end if;
    insert into public.bank_connections (id, bank_name, country, valid_until, status, updated_at)
    values (x->>'id', x->>'bankName', x->>'country', (x->>'validUntil')::timestamptz, x->>'status', now())
    on conflict (id) do update set bank_name = coalesce(excluded.bank_name, bank_connections.bank_name),
      country = coalesce(excluded.country, bank_connections.country), valid_until = coalesce(excluded.valid_until, bank_connections.valid_until),
      status = coalesce(excluded.status, bank_connections.status), updated_at = now();
    c := c + 1;
  end loop;

  for x in select * from jsonb_array_elements(coalesce(payload->'accounts', '[]')) loop
    if coalesce(x->>'id', '') = '' then raise exception 'accounts[%].id obbligatorio', a; end if;
    insert into public.bank_accounts (id, connection_id, bank_name, name, iban, currency, source, updated_at)
    values (x->>'id', x->>'connectionId', x->>'bankName', x->>'name', x->>'iban', coalesce(x->>'currency', 'EUR'), src, now())
    on conflict (id) do update set connection_id = coalesce(excluded.connection_id, bank_accounts.connection_id),
      bank_name = coalesce(excluded.bank_name, bank_accounts.bank_name), name = coalesce(excluded.name, bank_accounts.name),
      iban = coalesce(excluded.iban, bank_accounts.iban), currency = excluded.currency, source = coalesce(excluded.source, bank_accounts.source),
      updated_at = now();
    a := a + 1;
  end loop;

  for x in select * from jsonb_array_elements(coalesce(payload->'balances', '[]')) loop
    if coalesce(x->>'accountId', '') = '' then raise exception 'balances[%].accountId obbligatorio', b; end if;
    if jsonb_typeof(x->'amount') <> 'number' then raise exception 'balances[%].amount deve essere un numero', b; end if;
    insert into public.bank_accounts (id, currency, source) values (x->>'accountId', coalesce(x->>'currency', 'EUR'), src) on conflict do nothing;
    insert into public.bank_balances (account_id, type, date, amount, currency)
    values (x->>'accountId', coalesce(x->>'type', 'OTHR'), coalesce(left(x->>'date', 10)::date, synced::date), (x->>'amount')::numeric, coalesce(x->>'currency', 'EUR'))
    on conflict (account_id, type, date) do update set amount = excluded.amount, currency = excluded.currency;
    b := b + 1;
  end loop;

  for x in select * from jsonb_array_elements(coalesce(payload->'transactions', '[]')) loop
    if coalesce(x->>'id', '') = '' or coalesce(x->>'accountId', '') = '' then raise exception 'transactions[%]: id e accountId obbligatori', t; end if;
    if jsonb_typeof(x->'amount') <> 'number' then raise exception 'transactions[%].amount deve essere un numero', t; end if;
    if coalesce(x->>'bookingDate', '') !~ '^\d{4}-\d{2}-\d{2}' then raise exception 'transactions[%].bookingDate non valida', t; end if;
    insert into public.bank_accounts (id, currency, source) values (x->>'accountId', coalesce(x->>'currency', 'EUR'), src) on conflict do nothing;
    insert into public.bank_transactions (account_id, id, amount, currency, booking_date, value_date, description, counterparty, status)
    values (x->>'accountId', x->>'id', (x->>'amount')::numeric, coalesce(x->>'currency', 'EUR'), left(x->>'bookingDate', 10)::date,
            left(x->>'valueDate', 10)::date, x->>'description', x->>'counterparty', coalesce(x->>'status', 'BOOK'))
    on conflict (account_id, id) do update set amount = excluded.amount, currency = excluded.currency, booking_date = excluded.booking_date,
      value_date = excluded.value_date, description = excluded.description, counterparty = excluded.counterparty, status = excluded.status;
    t := t + 1;
  end loop;

  matched := public.yrols_match_bills();
  insert into public.bank_syncs (source, synced_at, summary)
  values (src, synced, jsonb_build_object('connections', c, 'accounts', a, 'balances', b, 'transactions', t));
  return jsonb_build_object('ok', true, 'connections', c, 'accounts', a, 'balances', b, 'transactions', t, 'billsMatched', matched);
end $$;

-- Permessi sulle funzioni: sync e match solo service_role; letture e conferme solo utenti autenticati.
revoke execute on all functions in schema public from public, anon;
grant execute on function public.yrols_bank_sync(jsonb), public.yrols_match_bills() to service_role;
revoke execute on function public.yrols_bank_sync(jsonb), public.yrols_match_bills() from authenticated;
grant execute on function public.yrols_is_member(), public.yrols_claim(), public.yrols_overview(), public.yrols_history(int),
  public.yrols_accept_suggestion(bigint, jsonb), public.yrols_balance_rank(text) to authenticated;
grant select on public.yrols_accounts, public.yrols_transactions to authenticated;
revoke all on public.yrols_accounts, public.yrols_transactions from anon;
