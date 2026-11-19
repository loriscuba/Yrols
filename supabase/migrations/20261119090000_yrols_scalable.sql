-- Scalable Capital tramite il server MCP ufficiale (https://mcp.scalable.capital/mcp), Edge Function yrols-scalable.
--
-- Scalable non è su Enable Banking: Yrols si collega come client OAuth pubblico (registrazione dinamica + PKCE)
-- e legge in sola lettura valore del portafoglio, liquidità, conto overnight e posizioni.
-- I token restano in questa tabella senza policy: li leggono solo service_role (la Edge Function).

create table yrols.scalable_auth (
  id text primary key default 'main' check (id = 'main'),
  client_id text not null,
  redirect_uri text not null,
  refresh_token text,
  access_token text,
  access_expires_at timestamptz,
  -- Lease per non rinnovare il token due volte in parallelo (il refresh token di Scalable ruota a ogni uso).
  refreshing_until timestamptz,
  status text not null default 'pending' check (status in ('pending','active','expired')),
  logged_in_at timestamptz,
  last_sync_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);
alter table yrols.scalable_auth enable row level security;
revoke all on yrols.scalable_auth from anon, authenticated;
grant all on yrols.scalable_auth to service_role;

-- Accessi avviati e non completati: "state" anti-CSRF e code_verifier PKCE.
create table yrols.scalable_auth_pending (
  state text primary key,
  code_verifier text not null,
  created_by uuid,
  created_at timestamptz not null default now()
);
alter table yrols.scalable_auth_pending enable row level security;
revoke all on yrols.scalable_auth_pending from anon, authenticated;
grant all on yrols.scalable_auth_pending to service_role;

-- Posizioni del portafoglio titoli (ultima lettura), visibili solo ai membri.
create table yrols.investment_holdings (
  account_id text not null references yrols.bank_accounts(id) on delete cascade,
  isin text not null,
  name text,
  quantity numeric(20,8),
  price numeric(16,4),
  currency text not null default 'EUR',
  value numeric(14,2),
  updated_at timestamptz not null default now(),
  primary key (account_id, isin)
);
alter table yrols.investment_holdings enable row level security;
revoke all on yrols.investment_holdings from anon;
create policy "solo proprietario" on yrols.investment_holdings for all to authenticated
  using (yrols.yrols_is_member()) with check (yrols.yrols_is_member());
grant select on yrols.investment_holdings to authenticated;
grant all on yrols.investment_holdings to service_role;

-- Stato del collegamento per il cruscotto, senza mai esporre i token.
-- Scalable chiede un nuovo accesso al più tardi 7 giorni dopo il login: expiresAt è quella stima.
create function yrols.yrols_scalable_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when not yrols.yrols_is_member() then null else (
    select jsonb_build_object('status', status, 'loggedInAt', logged_in_at, 'lastSyncAt', last_sync_at,
                              'expiresAt', logged_in_at + interval '7 days', 'lastError', last_error)
    from yrols.scalable_auth where status <> 'pending' or logged_in_at is not null
  ) end
$$;
revoke execute on function yrols.yrols_scalable_status() from public, anon;
grant execute on function yrols.yrols_scalable_status() to authenticated;
