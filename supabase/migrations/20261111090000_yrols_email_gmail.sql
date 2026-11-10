-- Collegamento Gmail dall'app (Edge Function yrols-email-auth), accesso Google OAuth in sola lettura.
--
-- Il refresh token di Google resta in questa tabella, senza policy: lo leggono solo service_role
-- (la Edge Function e la lettura su GitHub Actions). Da solo non basta per leggere la posta: serve
-- anche il client secret Google, che sta solo nei secret della Edge Function.
create table yrols.email_accounts (
  id text primary key default 'gmail',
  provider text not null default 'gmail' check (provider in ('gmail')),
  email text not null,
  refresh_token text not null,
  scope text,
  status text not null default 'active' check (status in ('active','expired')),
  last_error text,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table yrols.email_accounts enable row level security;
revoke all on yrols.email_accounts from anon, authenticated;
grant all on yrols.email_accounts to service_role;

-- Collegamenti avviati e non completati: solo lo "state" anti-CSRF.
create table yrols.email_auth_pending (
  state text primary key,
  created_by uuid,
  created_at timestamptz not null default now()
);
alter table yrols.email_auth_pending enable row level security;
revoke all on yrols.email_auth_pending from anon, authenticated;
grant all on yrols.email_auth_pending to service_role;

-- Stato del collegamento per il cruscotto, senza mai esporre il token.
create function yrols.yrols_email_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when not yrols.yrols_is_member() then null else jsonb_build_object(
    'account', (select jsonb_build_object('provider', provider, 'email', email, 'status', status,
                                          'lastError', last_error, 'connectedAt', connected_at)
                from yrols.email_accounts order by connected_at desc limit 1),
    'lastScan', (select jsonb_build_object('at', received_at, 'summary', summary)
                 from yrols.bank_syncs where source = 'email' order by id desc limit 1)
  ) end
$$;
revoke execute on function yrols.yrols_email_status() from public, anon;
grant execute on function yrols.yrols_email_status() to authenticated;
