-- Offerte con prezzo promozionale: monthly_cost è il prezzo iniziale, regular_cost quello a regime
-- (dopo promo_months mesi). regular_cost nullo = il prezzo non è promozionale, resta quello.
alter table yrols.saving_offers
  add column regular_cost numeric check (regular_cost is null or regular_cost >= 0),
  add column promo_months int check (promo_months is null or promo_months > 0);

-- Ora una riduzione conta sul prezzo a regime.
create or replace function yrols.yrols_save_offers(run jsonb) returns jsonb
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
                                    price_details, conditions, url, source, valid_until, run_id, regular_cost, promo_months)
    values (o->>'category', trim(o->>'provider'), trim(o->>'name'), nullif(o->>'priceType', ''),
            (o->>'monthlyCost')::numeric, nullif(o->>'currentMonthly', '')::numeric, nullif(o->>'currentProvider', ''),
            nullif(o->>'priceDetails', ''), nullif(o->>'conditions', ''), nullif(o->>'url', ''),
            coalesce(nullif(o->>'source', ''), 'web'), nullif(o->>'validUntil', '')::date, rid,
            nullif(o->>'regularCost', '')::numeric, nullif(o->>'promoMonths', '')::int)
    on conflict (category, lower(provider), lower(name)) do update set
      price_type = excluded.price_type, monthly_cost = excluded.monthly_cost, current_monthly = excluded.current_monthly,
      current_provider = excluded.current_provider, price_details = excluded.price_details, conditions = excluded.conditions,
      url = excluded.url, source = excluded.source, valid_until = excluded.valid_until, run_id = rid,
      regular_cost = excluded.regular_cost, promo_months = excluded.promo_months,
      active = true, last_seen = now(),
      -- Se il prezzo scende di almeno 1 €/mese torna "nuova", così si nota.
      status = case when s.status = 'vista' and coalesce(excluded.regular_cost, excluded.monthly_cost) < coalesce(s.regular_cost, s.monthly_cost) - 1 then 'nuova' else s.status end;
    n := n + 1;
  end loop;

  update yrols.saving_offers set active = false where category = any(cats) and run_id is distinct from rid and active;
  return jsonb_build_object('run', rid, 'offers', n);
end $$;
