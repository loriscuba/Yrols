-- Statistiche personalizzate (pagina "Statistiche"): ogni riga è una statistica richiesta da Loris.
-- "kind" dice come calcolarla nell'app, "config" ne tiene i parametri. Prima tipologia:
--   vacanza → { "country": "JP", "from": "2026-10-20", "to": "2026-10-29" | null,
--               "keywords": ["Suica"], "include": ["<id movimento>"], "exclude": ["<id movimento>"] }
-- Nessun dato bancario qui: i movimenti restano in bank_transactions, la statistica li filtra.

create table yrols.custom_stats (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('vacanza')),
  title text not null check (length(trim(title)) > 0),
  config jsonb not null default '{}'::jsonb,
  position int not null default 0,
  created_at timestamptz not null default now()
);

alter table yrols.custom_stats enable row level security;
create policy "solo proprietario" on yrols.custom_stats for all to authenticated
  using (yrols.yrols_is_member()) with check (yrols.yrols_is_member());
grant select, insert, update, delete on yrols.custom_stats to authenticated;
grant all on yrols.custom_stats to service_role;
grant usage, select on all sequences in schema yrols to authenticated, service_role;
