-- Bollette scaricate dalle aree clienti dei fornitori (MyFastweb, MySorgenia, Iliad…) da un'attività
-- programmata di Claude desktop sul PC di casa. La Edge Function "yrols-inbox" riceve il PDF, lo salva nel
-- bucket privato "yrols-fatture" (portale/<hash>.pdf) e lo mette in coda qui; la lettura su GitHub Actions
-- lo legge e lo salva tra le bollette (o tra le proposte se mancano dati).
create table yrols.portal_files (
  id bigint generated always as identity primary key,
  sha256 text not null unique check (sha256 ~ '^[0-9a-f]{64}$'),
  provider text,
  filename text,
  file_path text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  result text check (result in ('bill', 'suggestion', 'unreadable')),
  bill_id bigint
);
alter table yrols.portal_files enable row level security;
create policy "lettura membri" on yrols.portal_files for select to authenticated using (yrols.yrols_is_member());
grant select on yrols.portal_files to authenticated;
grant all on yrols.portal_files to service_role;

alter table yrols.bills drop constraint bills_source_check;
alter table yrols.bills add constraint bills_source_check check (source in ('manuale', 'pdf', 'email', 'portale'));
