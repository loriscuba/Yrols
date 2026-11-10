-- Collegamento e rinnovo delle banche dall'app (Edge Function yrols-bank-auth).

-- Consensi avviati e non ancora completati. Contiene solo lo "state" anti-CSRF e la banca scelta:
-- nessuna policy, quindi leggibile e scrivibile solo da service_role (la Edge Function).
create table yrols.bank_auth_pending (
  state text primary key,
  bank_name text not null,
  country text not null,
  consent_days int not null,
  replaces text,
  created_by uuid,
  created_at timestamptz not null default now()
);
alter table yrols.bank_auth_pending enable row level security;
revoke all on yrols.bank_auth_pending from anon, authenticated;
grant all on yrols.bank_auth_pending to service_role;

-- Enable Banking assegna un uid diverso a ogni conto a ogni nuovo consenso. Per non duplicare
-- conti e movimenti al rinnovo, l'id in Yrols resta quello storico e l'uid corrente va in eb_uid.
alter table yrols.bank_accounts add column eb_uid text;
alter table yrols.bank_accounts add column identification_hash text;
