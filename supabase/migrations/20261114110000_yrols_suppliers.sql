-- Anagrafica fornitori delle utenze. Le schede nascono dal riconoscimento automatico nel cruscotto
-- (movimenti, pagamenti ricorrenti, bollette, email) e l'utente le completa o le nasconde.
-- "monthly" è l'ultima stima della spesa mensile, aggiornata dal cruscotto: la leggono anche altre pagine.
create table yrols.suppliers (
  id bigint generated always as identity primary key,
  key text not null unique check (key ~ '^[a-z0-9-]+$'),
  name text not null check (length(trim(name)) > 0),
  kind text not null default 'altro' check (kind in ('luce','gas','acqua','internet','telefono','rifiuti','condominio','affitto','mutuo','altro')),
  status text not null default 'attivo' check (status in ('attivo','nascosto')),
  monthly numeric(12,2),
  direct_debit boolean,
  customer_code text,
  contract_code text,
  website text,
  phone text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table yrols.suppliers enable row level security;
create policy "solo proprietario" on yrols.suppliers for all to authenticated
  using (yrols.yrols_is_member()) with check (yrols.yrols_is_member());
grant select, insert, update, delete on yrols.suppliers to authenticated;
grant all on yrols.suppliers to service_role;

create function yrols.yrols_touch_updated_at() returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;
create trigger suppliers_touch before update on yrols.suppliers for each row execute function yrols.yrols_touch_updated_at();
