-- Login rafforzato: i dati del cruscotto si vedono solo con password + codice a 6 cifre (sessione "aal2").
-- yrols_is_member() è usata da tutte le regole RLS, dai bucket yrols-fatture / yrols-scontrini, dalle funzioni
-- del cruscotto e dalle Edge Function: cambiandola qui la regola vale ovunque. Chi ha solo la password (aal1)
-- non legge né scrive nulla, nemmeno chiamando Supabase direttamente.
-- Le Action di GitHub usano la chiave service_role e non passano da qui: non cambiano.

create or replace function yrols.yrols_is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
     and exists (select 1 from yrols.yrols_members where user_id = auth.uid())
$$;

-- Il proprietario c'è già: il "primo che entra diventa proprietario" vale solo a tabella vuota e con il codice.
create or replace function yrols.yrols_claim() returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then return false; end if;
  lock table yrols.yrols_members in exclusive mode;
  if not exists (select 1 from yrols.yrols_members) then
    insert into yrols.yrols_members (user_id) values (auth.uid());
  end if;
  return yrols.yrols_is_member();
end $$;
