-- Risparmio: offerte di luce, gas, internet e telefonia trovate ogni settimana su Internet,
-- confrontate con quanto si spende oggi. Le scrive il controllo settimanale (yrols_save_offers),
-- il cruscotto le legge e permette di nasconderle o segnarle come viste.

-- Profilo di consumo usato per stimare quanto costerebbe ogni offerta (una sola riga).
create table yrols.saving_profile (
  id int primary key default 1 check (id = 1),
  kwh_year numeric check (kwh_year is null or kwh_year > 0),
  smc_year numeric check (smc_year is null or smc_year > 0),
  power_kw numeric check (power_kw is null or power_kw > 0),
  resident boolean not null default true,
  province text,
  internet_min_mbps int check (internet_min_mbps is null or internet_min_mbps > 0),
  mobile_lines int check (mobile_lines is null or mobile_lines >= 0),
  mobile_gb int check (mobile_gb is null or mobile_gb >= 0),
  notes text,
  updated_at timestamptz not null default now()
);
insert into yrols.saving_profile (id) values (1);

-- Ogni controllo settimanale: quando, cosa ha guardato e un riepilogo leggibile.
create table yrols.saving_runs (
  id bigint generated always as identity primary key,
  run_at timestamptz not null default now(),
  sources text[] not null default '{}',
  summary text,
  offers_count int not null default 0
);

create table yrols.saving_offers (
  id bigint generated always as identity primary key,
  category text not null check (category in ('luce', 'gas', 'internet', 'telefono', 'abbonamenti')),
  provider text not null,
  name text not null,
  price_type text check (price_type in ('fisso', 'variabile')),
  -- Stima della spesa mensile con questa offerta per il profilo di consumo (IVA e oneri inclusi).
  monthly_cost numeric not null check (monthly_cost >= 0),
  -- Spesa mensile attuale per la stessa voce usata nel confronto, se nota.
  current_monthly numeric check (current_monthly is null or current_monthly >= 0),
  current_provider text,
  price_details text,
  conditions text,
  url text check (url is null or url ~* '^https://'),
  source text not null,
  valid_until date,
  status text not null default 'nuova' check (status in ('nuova', 'vista', 'nascosta')),
  active boolean not null default true,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  run_id bigint references yrols.saving_runs(id) on delete set null
);
create unique index saving_offers_uq on yrols.saving_offers (category, lower(provider), lower(name));
create index saving_offers_active on yrols.saving_offers (active, category);

-- Salva un controllo: {sources, summary, offers:[{category, provider, name, priceType, monthlyCost, currentMonthly,
-- currentProvider, priceDetails, conditions, url, source, validUntil}]}.
-- Aggiorna le offerte già viste (tenendo "vista"/"nascosta"), aggiunge le nuove e spegne quelle non più trovate
-- nelle categorie controllate. security invoker: valgono i permessi di chi chiama.
create function yrols.yrols_save_offers(run jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  rid bigint; o jsonb; cats text[]; n int := 0;
begin
  if jsonb_typeof(run->'offers') <> 'array' then raise exception 'offers mancante' using errcode = '23502'; end if;
  insert into yrols.saving_runs (sources, summary, offers_count)
    values (coalesce(array(select jsonb_array_elements_text(run->'sources')), '{}'), nullif(run->>'summary', ''),
            jsonb_array_length(run->'offers'))
    returning id into rid;
  select coalesce(array_agg(distinct e->>'category'), '{}') into cats from jsonb_array_elements(run->'offers') e;

  for o in select * from jsonb_array_elements(run->'offers') loop
    insert into yrols.saving_offers as s (category, provider, name, price_type, monthly_cost, current_monthly, current_provider,
                                    price_details, conditions, url, source, valid_until, run_id)
    values (o->>'category', trim(o->>'provider'), trim(o->>'name'), nullif(o->>'priceType', ''),
            (o->>'monthlyCost')::numeric, nullif(o->>'currentMonthly', '')::numeric, nullif(o->>'currentProvider', ''),
            nullif(o->>'priceDetails', ''), nullif(o->>'conditions', ''), nullif(o->>'url', ''),
            coalesce(nullif(o->>'source', ''), 'web'), nullif(o->>'validUntil', '')::date, rid)
    on conflict (category, lower(provider), lower(name)) do update set
      price_type = excluded.price_type, monthly_cost = excluded.monthly_cost, current_monthly = excluded.current_monthly,
      current_provider = excluded.current_provider, price_details = excluded.price_details, conditions = excluded.conditions,
      url = excluded.url, source = excluded.source, valid_until = excluded.valid_until, run_id = rid,
      active = true, last_seen = now(),
      -- Se il prezzo scende di almeno 1 €/mese torna "nuova", così si nota.
      status = case when s.status = 'vista' and excluded.monthly_cost < s.monthly_cost - 1 then 'nuova' else s.status end;
    n := n + 1;
  end loop;

  update yrols.saving_offers set active = false where category = any(cats) and run_id is distinct from rid and active;
  return jsonb_build_object('run', rid, 'offers', n);
end $$;

do $$
declare t text;
begin
  foreach t in array array['saving_profile', 'saving_runs', 'saving_offers'] loop
    execute format('alter table yrols.%I enable row level security', t);
    execute format('revoke all on yrols.%I from anon', t);
    execute format('create policy "solo proprietario" on yrols.%I for all to authenticated using (yrols.yrols_is_member()) with check (yrols.yrols_is_member())', t);
    execute format('grant select, insert, update, delete on yrols.%I to authenticated', t);
    execute format('grant all on yrols.%I to service_role', t);
  end loop;
end $$;
revoke insert, delete on yrols.saving_profile from authenticated;
grant usage, select on all sequences in schema yrols to authenticated, service_role;
revoke execute on function yrols.yrols_save_offers(jsonb) from public, anon;
grant execute on function yrols.yrols_save_offers(jsonb) to authenticated, service_role;
