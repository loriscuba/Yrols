-- Fondo pensione negoziale: Loris carica ogni mese dall'app l'Excel "importi versati"
-- e, quando lo scarica, il PDF "sintesi posizione". L'app legge i file nel browser e chiama yrols_pension_import.
--
-- L'Excel è la storia completa dei contributi: a ogni caricamento sostituisce quella salvata.
-- Il PDF dà il totale esatto (quote × valore quota + importi in attesa). L'Excel non ha quote né valore quota:
-- senza un PDF nuovo il totale è stimato come "ultimo totale dal PDF + contributi arrivati dopo".
-- Il fondo pensione non entra nel patrimonio sui conti (non è disponibile fino alla pensione): ha una voce sua.
-- Nessun dato personale qui: i valori stanno nel database, non nel repository pubblico.

create table yrols.pension_funds (
  id text primary key,
  name text not null,
  comparto text,
  paid numeric(14,2) not null default 0,          -- importi versati (ultimo dato, Excel o PDF)
  total numeric(14,2),                            -- totale posizione (esatto dal PDF o stimato)
  total_date date,
  estimated boolean not null default false,       -- true: totale stimato dai versamenti, in attesa di un PDF
  units numeric(20,3),                            -- quote in essere (PDF)
  unit_value numeric(14,4),                       -- valore quota (PDF)
  unit_value_date date,
  invested numeric(14,2),                         -- controvalore delle quote (PDF)
  pending numeric(14,2) not null default 0,       -- importi in attesa di investimento (PDF)
  result numeric(14,2),                           -- risultato della gestione (PDF)
  allocation jsonb,                               -- {"Azioni": 62.73, ...} in percentuale
  pdf_date date,                                  -- ultima sintesi: base della stima
  pdf_total numeric(14,2),
  pdf_paid numeric(14,2),
  excel_at timestamptz,
  pdf_at timestamptz,
  updated_at timestamptz not null default now()
);

create table yrols.pension_contributions (
  fund_id text not null references yrols.pension_funds(id) on delete cascade,
  seq int not null,                               -- ordine delle righe nell'Excel (lo stesso mese può avere più righe)
  year int not null,
  period int not null,                            -- mese di competenza
  total numeric(12,2) not null,
  employee numeric(12,2) not null default 0,      -- aderente
  employer numeric(12,2) not null default 0,      -- azienda
  tfr numeric(12,2) not null default 0,
  voluntary numeric(12,2) not null default 0,
  tfr_silent numeric(12,2) not null default 0,
  tfr_revaluation numeric(12,2) not null default 0,
  welfare numeric(12,2) not null default 0,       -- premio di produzione convertito
  transfer numeric(12,2) not null default 0,      -- trasferimento da altro fondo / reintegro
  status text,                                    -- Quotato, Spesato (in attesa di investimento)…
  kind text,                                      -- Contributo, Da altro fondo…
  primary key (fund_id, seq)
);

create table yrols.pension_history (
  fund_id text not null references yrols.pension_funds(id) on delete cascade,
  date date not null,
  total numeric(14,2) not null,
  paid numeric(14,2) not null,
  estimated boolean not null default false,
  primary key (fund_id, date)
);

do $$ declare t text; begin
  foreach t in array array['pension_funds','pension_contributions','pension_history'] loop
    execute format('alter table yrols.%I enable row level security', t);
    execute format('revoke all on yrols.%I from anon', t);
    execute format('create policy "solo proprietario" on yrols.%I for select to authenticated using (yrols.yrols_is_member())', t);
    execute format('grant select on yrols.%I to authenticated', t);
    execute format('grant all on yrols.%I to service_role', t);
  end loop;
end $$;
revoke insert, update, delete on yrols.pension_funds, yrols.pension_contributions, yrols.pension_history from authenticated;

-- Dall'app, dopo aver letto i file nel browser.
-- data: {"name": "...", "contributions": [{year, period, total, employee, ...}], "position": {date, paid, result, total, ...}}
-- Le due parti sono facoltative: si può caricare solo l'Excel, solo il PDF o entrambi.
create function yrols.yrols_pension_import(fund text, data jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  f yrols.pension_funds;
  p jsonb := data->'position';
  rows int := 0;
  excel_paid numeric;
begin
  if not yrols.yrols_is_member() then raise exception 'non autorizzato'; end if;
  if coalesce(fund, '') = '' then raise exception 'fondo mancante'; end if;
  if data->'contributions' is null and p is null then raise exception 'nessun dato da importare'; end if;
  insert into yrols.pension_funds (id, name) values (fund, coalesce(nullif(data->>'name', ''), 'Fondo pensione'))
    on conflict (id) do nothing;

  if jsonb_typeof(data->'contributions') = 'array' then
    if jsonb_array_length(data->'contributions') = 0 then raise exception 'Excel senza contributi'; end if;
    delete from yrols.pension_contributions where fund_id = fund;
    insert into yrols.pension_contributions (fund_id, seq, year, period, total, employee, employer, tfr, voluntary,
        tfr_silent, tfr_revaluation, welfare, transfer, status, kind)
      select fund, x.n::int, (x.c->>'year')::int, (x.c->>'period')::int, (x.c->>'total')::numeric,
        coalesce((x.c->>'employee')::numeric, 0), coalesce((x.c->>'employer')::numeric, 0), coalesce((x.c->>'tfr')::numeric, 0),
        coalesce((x.c->>'voluntary')::numeric, 0), coalesce((x.c->>'tfrSilent')::numeric, 0), coalesce((x.c->>'tfrRevaluation')::numeric, 0),
        coalesce((x.c->>'welfare')::numeric, 0), coalesce((x.c->>'transfer')::numeric, 0), x.c->>'status', x.c->>'kind'
      from jsonb_array_elements(data->'contributions') with ordinality as x(c, n);
    get diagnostics rows = row_count;
    select coalesce(sum(total), 0) into excel_paid from yrols.pension_contributions where fund_id = fund;
    update yrols.pension_funds set paid = excel_paid, excel_at = now(), updated_at = now() where id = fund;
  end if;

  if jsonb_typeof(p) = 'object' then
    if (p->>'total') is null or (p->>'date') is null then raise exception 'sintesi senza totale'; end if;
    update yrols.pension_funds set
      comparto = coalesce(nullif(p->>'comparto', ''), comparto),
      paid = coalesce(excel_paid, greatest(paid, (p->>'paid')::numeric)),
      units = (p->>'units')::numeric, unit_value = (p->>'unitValue')::numeric, unit_value_date = (p->>'unitValueDate')::date,
      invested = (p->>'invested')::numeric, pending = coalesce((p->>'pending')::numeric, 0), result = (p->>'result')::numeric,
      allocation = case when coalesce(p->'allocation', '{}'::jsonb) = '{}'::jsonb then allocation else p->'allocation' end,
      pdf_date = (p->>'date')::date, pdf_total = (p->>'total')::numeric, pdf_paid = coalesce((p->>'paid')::numeric, excel_paid, paid),
      pdf_at = now(), updated_at = now()
    where id = fund
      -- Una sintesi più vecchia di quella salvata non sovrascrive i dati.
      and (pdf_date is null or pdf_date <= (p->>'date')::date);
  end if;

  -- Totale: esatto dall'ultima sintesi, più i contributi arrivati dopo (stima) se l'Excel ne ha di nuovi.
  select * into f from yrols.pension_funds where id = fund;
  if f.pdf_total is not null then
    f.total := f.pdf_total + greatest(f.paid - f.pdf_paid, 0);
    f.estimated := f.paid > f.pdf_paid;
    f.total_date := case when f.estimated then greatest(current_date, f.pdf_date) else f.pdf_date end;
  else
    f.total := f.paid; f.estimated := true; f.total_date := current_date;
  end if;
  update yrols.pension_funds set total = f.total, estimated = f.estimated, total_date = f.total_date where id = fund;
  insert into yrols.pension_history (fund_id, date, total, paid, estimated)
    values (fund, f.total_date, f.total, f.paid, f.estimated)
    on conflict (fund_id, date) do update set total = excluded.total, paid = excluded.paid, estimated = excluded.estimated
      -- Un valore esatto del giorno non viene sostituito da una stima.
      where yrols.pension_history.estimated or not excluded.estimated;

  return jsonb_build_object('fund', fund, 'contributions', rows, 'paid', f.paid, 'total', f.total,
    'estimated', f.estimated, 'date', f.total_date);
end $$;
revoke execute on function yrols.yrols_pension_import(text, jsonb) from public, anon;
grant execute on function yrols.yrols_pension_import(text, jsonb) to authenticated;
