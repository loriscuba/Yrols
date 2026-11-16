-- Scontrini: foto scattata dall'app, dati letti dallo scontrino e collegamento automatico al movimento
-- del conto con lo stesso importo (pagamento elettronico). La foto sta nel bucket privato "yrols-scontrini".
-- "grocery_prices" è il listino di riferimento dei supermercati vicini, usato per i consigli di risparmio.

create table yrols.receipts (
  id bigint generated always as identity primary key,
  store text,
  store_vat text,
  store_address text,
  purchase_date date not null default current_date,
  purchase_time time,
  total numeric(10,2) not null check (total > 0),
  items jsonb,
  analysis jsonb,
  analyzed_at timestamptz,
  file_path text,
  tx_account_id text,
  tx_id text,
  -- auto: collegato in automatico; manuale: scelto dall'utente; nessuno: l'utente ha scollegato (niente più automatismi)
  match text check (match in ('auto', 'manuale', 'nessuno')),
  notes text,
  created_at timestamptz not null default now(),
  foreign key (tx_account_id, tx_id) references yrols.bank_transactions (account_id, id) on delete set null,
  check ((tx_id is null) = (tx_account_id is null))
);
create unique index receipts_tx_uq on yrols.receipts (tx_account_id, tx_id) where tx_id is not null;
create index receipts_date on yrols.receipts (purchase_date desc);

create table yrols.grocery_prices (
  id bigint generated always as identity primary key,
  store text not null,                 -- catena, es. "Lidl"
  product text not null,               -- nome generico, es. "Banane"
  detail text,                         -- marca o formato, es. "al kg", "14 pz taglia 5"
  price numeric(10,2) not null check (price >= 0),
  unit text,                           -- kg, l, pz, conf
  unit_price numeric(10,2),            -- prezzo per unità (kg, l, pezzo), se ha senso
  source text,                         -- pagina o volantino da cui viene il prezzo
  checked_on date not null default current_date,
  created_at timestamptz not null default now()
);
create index grocery_prices_product on yrols.grocery_prices (lower(product));

do $$
declare t text;
begin
  foreach t in array array['receipts', 'grocery_prices'] loop
    execute format('alter table yrols.%I enable row level security', t);
    execute format('create policy "solo proprietario" on yrols.%I for all to authenticated using (yrols.yrols_is_member()) with check (yrols.yrols_is_member())', t);
    execute format('grant select, insert, update, delete on yrols.%I to authenticated', t);
    execute format('grant all on yrols.%I to service_role', t);
  end loop;
end $$;
grant usage, select on all sequences in schema yrols to authenticated, service_role;

-- Collega gli scontrini non ancora abbinati ai movimenti in uscita con lo stesso importo, dal giorno prima
-- a 6 giorni dopo l'acquisto (le carte contabilizzano in ritardo). A parità, vince il movimento che cita
-- il negozio e poi quello più vicino come data. Un movimento va a un solo scontrino.
create function yrols.yrols_match_receipts() returns int
language plpgsql set search_path = '' as $$
declare r record; acc text; tid text; n int := 0;
begin
  for r in select id, store, total, purchase_date from yrols.receipts
           where tx_id is null and match is distinct from 'nessuno' order by purchase_date, id loop
    select t.account_id, t.id into acc, tid
    from yrols.bank_transactions t
    where t.amount = -r.total
      and coalesce(t.value_date, t.booking_date) between r.purchase_date - 1 and r.purchase_date + 6
      and not exists (select 1 from yrols.receipts x where x.tx_account_id = t.account_id and x.tx_id = t.id)
    order by
      exists (
        select 1 from regexp_split_to_table(lower(coalesce(r.store, '')), '[^a-z0-9àèéìòù]+') w
        where length(w) >= 4 and w not in ('carni', 'market', 'supermercato', 'supermercati', 'store', 'italia', 'savona', 'societa')
          and lower(coalesce(t.description, '') || ' ' || coalesce(t.counterparty, '')) like '%' || w || '%'
      ) desc,
      abs(coalesce(t.value_date, t.booking_date) - r.purchase_date),
      t.booking_date
    limit 1;
    if tid is not null then
      update yrols.receipts set tx_account_id = acc, tx_id = tid, match = 'auto' where id = r.id;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- A ogni sincronizzazione della banca riprova l'abbinamento. Il trigger è rimandato alla fine della
-- transazione, così vede tutti i movimenti arrivati insieme (la sync li inserisce uno alla volta):
-- la prima chiamata fa il lavoro, le successive non trovano più nulla da collegare.
create function yrols.yrols_receipts_after_tx() returns trigger
language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from yrols.receipts where tx_id is null and match is distinct from 'nessuno') then
    perform yrols.yrols_match_receipts();
  end if;
  return null;
end $$;
create constraint trigger bank_transactions_match_receipts after insert or update on yrols.bank_transactions
  deferrable initially deferred for each row execute function yrols.yrols_receipts_after_tx();

-- Movimenti che potrebbero essere lo scontrino: stesso importo entro 10 giorni, o importo vicino (±1 €) entro 3.
create function yrols.yrols_receipt_candidates(receipt_id bigint) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'accountId', t.account_id, 'id', t.id, 'amount', t.amount::float8, 'bookingDate', t.booking_date,
      'description', t.description, 'counterparty', t.counterparty, 'accountName', a.name, 'bankName', a.bank_name,
      'exact', t.amount = -r.total)
    order by (t.amount = -r.total) desc, abs(t.booking_date - r.purchase_date)), '[]'::jsonb)
  from yrols.receipts r
  join yrols.bank_transactions t on t.amount < 0 and (
       (t.amount = -r.total and abs(t.booking_date - r.purchase_date) <= 10)
    or (abs(t.amount + r.total) <= 1 and abs(t.booking_date - r.purchase_date) <= 3))
  left join yrols.bank_accounts a on a.id = t.account_id
  where r.id = receipt_id
    and not exists (select 1 from yrols.receipts x where x.tx_account_id = t.account_id and x.tx_id = t.id and x.id <> r.id)
$$;

create view yrols.yrols_receipts with (security_invoker = true) as
  select r.id, r.store, r.store_vat as "storeVat", r.store_address as "storeAddress", r.purchase_date as "purchaseDate",
         r.purchase_time as "purchaseTime", r.total::float8 as total, r.items, r.analysis, r.analyzed_at as "analyzedAt",
         r.file_path as "filePath", r.match, r.notes, r.created_at as "createdAt",
         case when t.id is null then null else jsonb_build_object(
           'accountId', t.account_id, 'id', t.id, 'amount', t.amount::float8, 'bookingDate', t.booking_date,
           'description', t.description, 'counterparty', t.counterparty, 'accountName', a.name, 'bankName', a.bank_name) end as tx
  from yrols.receipts r
  left join yrols.bank_transactions t on t.account_id = r.tx_account_id and t.id = r.tx_id
  left join yrols.bank_accounts a on a.id = t.account_id;
grant select on yrols.yrols_receipts to authenticated;

revoke execute on function yrols.yrols_match_receipts(), yrols.yrols_receipt_candidates(bigint), yrols.yrols_receipts_after_tx() from public, anon;
grant execute on function yrols.yrols_match_receipts(), yrols.yrols_receipt_candidates(bigint) to authenticated, service_role;

-- Bucket privato per le foto degli scontrini (solo dove esiste Supabase Storage; i test con PGlite non lo hanno).
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('yrols-scontrini', 'yrols-scontrini', false, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do nothing;
    execute $p$create policy "yrols scontrini: lettura" on storage.objects for select to authenticated
      using (bucket_id = 'yrols-scontrini' and yrols.yrols_is_member())$p$;
    execute $p$create policy "yrols scontrini: caricamento" on storage.objects for insert to authenticated
      with check (bucket_id = 'yrols-scontrini' and yrols.yrols_is_member())$p$;
    execute $p$create policy "yrols scontrini: eliminazione" on storage.objects for delete to authenticated
      using (bucket_id = 'yrols-scontrini' and yrols.yrols_is_member())$p$;
  end if;
end $$;
