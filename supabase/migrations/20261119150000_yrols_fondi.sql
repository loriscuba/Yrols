-- Fondi comuni non raggiungibili via API (es. PAC Fineco): quote e valore di carico inseriti una volta,
-- poi aggiornati da soli col NAV pubblico del fondo (GitHub Action "Fondi", script apps/server/src/fundsCloud.ts).
--
-- Ogni rata del PAC (pac_amount il giorno pac_day di ogni mese) compra quote al primo NAV disponibile
-- da quel giorno in poi. Il fondo compare tra i conti (bank_accounts, source 'fondo') col valore di mercato,
-- quindi entra nel totale e nello storico come il portafoglio Scalable.
-- Nessun dato personale qui: il fondo di Loris si inserisce nel database, non nel repository pubblico.

create table yrols.funds (
  id text primary key,                       -- è anche l'id del conto in bank_accounts
  isin text not null unique,
  name text not null,
  bank_name text not null default 'Fineco',
  nav_url text,                              -- pagina pubblica del gestore col NAV (facoltativa)
  quantity numeric(20,6) not null check (quantity >= 0),
  cost numeric(14,2) not null check (cost >= 0),        -- valore di carico
  pac_amount numeric(10,2) not null default 0 check (pac_amount >= 0),
  pac_day int check (pac_day between 1 and 28),
  pac_paid int not null default 0,
  pac_total int,
  pac_next date,                             -- prossima rata ancora da contare
  last_nav numeric(14,4),
  last_nav_date date,
  updated_at timestamptz not null default now()
);

create table yrols.fund_navs (
  isin text not null,
  nav_date date not null,
  nav numeric(14,4) not null check (nav > 0),
  source text,
  fetched_at timestamptz not null default now(),
  primary key (isin, nav_date)
);

create table yrols.fund_pac_purchases (
  fund_id text not null references yrols.funds(id) on delete cascade,
  due_date date not null,
  nav_date date not null,
  nav numeric(14,4) not null,
  amount numeric(10,2) not null,
  quantity numeric(20,6) not null,
  created_at timestamptz not null default now(),
  primary key (fund_id, due_date)
);

do $$ declare t text; begin
  foreach t in array array['funds','fund_navs','fund_pac_purchases'] loop
    execute format('alter table yrols.%I enable row level security', t);
    execute format('revoke all on yrols.%I from anon', t);
    execute format('create policy "solo proprietario" on yrols.%I for select to authenticated using (yrols.yrols_is_member())', t);
    execute format('grant select on yrols.%I to authenticated', t);
    execute format('grant all on yrols.%I to service_role', t);
  end loop;
end $$;
revoke insert, update, delete on yrols.funds, yrols.fund_navs, yrols.fund_pac_purchases from authenticated;

-- Stessa data del mese successivo (pac_day è al massimo 28, quindi esiste sempre).
create function yrols.yrols_fund_next_due(d date, day int) returns date language sql immutable set search_path = '' as $$
  select (date_trunc('month', d) + interval '1 month')::date + (day - 1)
$$;

-- Conta le rate scadute che hanno già un NAV e riscrive conto, saldo e posizione del fondo.
create function yrols.yrols_fund_refresh(fund text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  f yrols.funds;
  n record;
  q numeric;
  bought int := 0;
begin
  select * into f from yrols.funds where id = fund for update;
  if not found then return null; end if;
  while f.pac_amount > 0 and f.pac_day is not null and f.pac_next is not null
        and (f.pac_total is null or f.pac_paid < f.pac_total) loop
    select nav_date, nav into n from yrols.fund_navs
      where isin = f.isin and nav_date >= f.pac_next order by nav_date limit 1;
    exit when not found;
    q := round(f.pac_amount / n.nav, 3);    -- Fineco mostra le quote con 3 decimali
    insert into yrols.fund_pac_purchases (fund_id, due_date, nav_date, nav, amount, quantity)
      values (f.id, f.pac_next, n.nav_date, n.nav, f.pac_amount, q) on conflict do nothing;
    f.quantity := f.quantity + q;
    f.cost := f.cost + f.pac_amount;
    f.pac_paid := f.pac_paid + 1;
    f.pac_next := yrols.yrols_fund_next_due(f.pac_next, f.pac_day);
    bought := bought + 1;
  end loop;
  select nav_date, nav into n from yrols.fund_navs where isin = f.isin order by nav_date desc limit 1;
  if found then f.last_nav := n.nav; f.last_nav_date := n.nav_date; end if;
  update yrols.funds set quantity = f.quantity, cost = f.cost, pac_paid = f.pac_paid, pac_next = f.pac_next,
    last_nav = f.last_nav, last_nav_date = f.last_nav_date, updated_at = now() where id = f.id;

  insert into yrols.bank_accounts (id, connection_id, bank_name, name, iban, currency, source, updated_at)
    values (f.id, 'fondi', f.bank_name, f.name, null, 'EUR', 'fondo', now())
    on conflict (id) do update set bank_name = excluded.bank_name, name = excluded.name, source = 'fondo', updated_at = now();
  if f.last_nav is not null then
    insert into yrols.bank_balances (account_id, type, date, amount, currency)
      values (f.id, 'VALU', f.last_nav_date, round(f.quantity * f.last_nav, 2), 'EUR')
      on conflict (account_id, type, date) do update set amount = excluded.amount;
    insert into yrols.investment_holdings (account_id, isin, name, quantity, price, currency, value, updated_at)
      values (f.id, f.isin, f.name, f.quantity, f.last_nav, 'EUR', round(f.quantity * f.last_nav, 2), now())
      on conflict (account_id, isin) do update set name = excluded.name, quantity = excluded.quantity, price = excluded.price,
        value = excluded.value, updated_at = now();
  end if;
  return jsonb_build_object('fund', f.id, 'bought', bought, 'navDate', f.last_nav_date);
end $$;

-- Chiamata dalla GitHub Action con service_role: salva i NAV letti e aggiorna i fondi.
-- payload: {"navs": [{"isin": "...", "date": "YYYY-MM-DD", "nav": 123.45, "source": "fam"}]}
create function yrols.yrols_fund_sync(payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  saved int := 0;
  fid text;
  bought int := 0;
  r jsonb;
begin
  insert into yrols.fund_navs (isin, nav_date, nav, source)
    select x->>'isin', (x->>'date')::date, (x->>'nav')::numeric, x->>'source'
    from jsonb_array_elements(coalesce(payload->'navs', '[]'::jsonb)) x
    where (x->>'nav')::numeric > 0
    on conflict (isin, nav_date) do update set nav = excluded.nav, source = excluded.source, fetched_at = now();
  get diagnostics saved = row_count;
  for fid in select id from yrols.funds order by id loop
    r := yrols.yrols_fund_refresh(fid);
    bought := bought + coalesce((r->>'bought')::int, 0);
  end loop;
  return jsonb_build_object('navs', saved, 'funds', (select count(*) from yrols.funds), 'pac', bought);
end $$;
revoke execute on function yrols.yrols_fund_refresh(text) from public, anon, authenticated;
revoke execute on function yrols.yrols_fund_sync(jsonb) from public, anon, authenticated;
grant execute on function yrols.yrols_fund_refresh(text) to service_role;
grant execute on function yrols.yrols_fund_sync(jsonb) to service_role;

-- Dal cruscotto: correzione dei dati con quelli che mostra Fineco (quote, valore di carico, PAC).
-- Dopo la correzione si contano solo le rate future: quote e carico inseriti includono già quelle passate.
create function yrols.yrols_fund_update(fund text, data jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  f yrols.funds;
  day int;
begin
  if not yrols.yrols_is_member() then raise exception 'non autorizzato'; end if;
  select * into f from yrols.funds where id = fund for update;
  if not found then raise exception 'fondo non trovato'; end if;
  day := coalesce((data->>'pacDay')::int, f.pac_day);
  update yrols.funds set
    quantity = coalesce((data->>'quantity')::numeric, quantity),
    cost = coalesce((data->>'cost')::numeric, cost),
    pac_amount = coalesce((data->>'pacAmount')::numeric, pac_amount),
    pac_day = day,
    pac_paid = coalesce((data->>'pacPaid')::int, pac_paid),
    pac_total = coalesce((data->>'pacTotal')::int, pac_total),
    pac_next = case when day is null then null
      when data ? 'pacNext' then (data->>'pacNext')::date
      when extract(day from current_date) <= day then (date_trunc('month', current_date))::date + (day - 1)
      else yrols.yrols_fund_next_due(current_date, day) end,
    updated_at = now()
  where id = fund;
  return yrols.yrols_fund_refresh(fund);
end $$;
revoke execute on function yrols.yrols_fund_update(text, jsonb) from public, anon;
grant execute on function yrols.yrols_fund_update(text, jsonb) to authenticated;
