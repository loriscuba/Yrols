-- Fatture: PDF caricati a mano o arrivati per email, con i dati letti dal documento.
-- Il PDF sta nel bucket privato "yrols-fatture" (Supabase Storage), visibile solo ai membri di Yrols.

alter table yrols.bills
  add column invoice_number text,
  add column issue_date date,
  add column items jsonb,
  add column file_path text,
  add column source text not null default 'manuale' check (source in ('manuale', 'pdf', 'email'));
create unique index bills_invoice_uq on yrols.bills (lower(provider), invoice_number) where invoice_number is not null;

alter table yrols.email_suggestions
  add column invoice_number text,
  add column issue_date date,
  add column period_from date,
  add column period_to date,
  add column items jsonb,
  add column file_path text;

-- Salva una fattura senza doppioni: se c'è già la stessa fattura (numero, oppure fornitore+importo+scadenza)
-- la completa invece di crearne un'altra. Chiude anche le proposte email che parlano della stessa fattura.
-- security invoker: valgono le regole RLS di chi chiama.
create function yrols.yrols_save_invoice(bill jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  prov text := nullif(trim(bill->>'provider'), '');
  amt numeric := nullif(replace(bill->>'amount', ',', '.'), '')::numeric;
  due date := nullif(bill->>'dueDate', '')::date;
  num text := nullif(trim(bill->>'invoiceNumber'), '');
  existing_id bigint; merged boolean := false;
begin
  if prov is null or amt is null or due is null then raise exception 'Completa i dati: fornitore, importo e scadenza' using errcode = '23502'; end if;
  select id into existing_id from yrols.bills b
    where lower(b.provider) = lower(prov)
      and ((num is not null and b.invoice_number = num)
           or (b.amount = amt and b.due_date = due and (b.invoice_number is null or num is null)))
    order by (b.invoice_number = num) desc nulls last, id limit 1;
  if existing_id is not null then
    merged := true;
    update yrols.bills b set
      kind = coalesce(nullif(bill->>'kind', ''), b.kind),
      amount = amt, due_date = due,
      period_from = coalesce(nullif(bill->>'periodFrom', '')::date, b.period_from),
      period_to = coalesce(nullif(bill->>'periodTo', '')::date, b.period_to),
      paid_at = coalesce(nullif(bill->>'paidAt', '')::date, b.paid_at),
      notes = coalesce(nullif(bill->>'notes', ''), b.notes),
      invoice_number = coalesce(num, b.invoice_number),
      issue_date = coalesce(nullif(bill->>'issueDate', '')::date, b.issue_date),
      items = coalesce(case when jsonb_typeof(bill->'items') = 'array' then bill->'items' end, b.items),
      file_path = coalesce(nullif(bill->>'filePath', ''), b.file_path)
    where b.id = existing_id;
  else
    insert into yrols.bills (provider, kind, amount, due_date, period_from, period_to, paid_at, notes,
                             invoice_number, issue_date, items, file_path, source)
    values (prov, coalesce(nullif(bill->>'kind', ''), 'altro'), amt, due,
            nullif(bill->>'periodFrom', '')::date, nullif(bill->>'periodTo', '')::date, nullif(bill->>'paidAt', '')::date,
            nullif(bill->>'notes', ''), num, nullif(bill->>'issueDate', '')::date,
            case when jsonb_typeof(bill->'items') = 'array' then bill->'items' end, nullif(bill->>'filePath', ''),
            coalesce(nullif(bill->>'source', ''), 'manuale'))
    returning id into existing_id;
  end if;
  update yrols.email_suggestions s set status = 'accepted', created_id = existing_id
    where s.status = 'pending' and s.kind = 'bill'
      and ((num is not null and s.invoice_number = num)
           or (lower(coalesce(s.provider, '')) = lower(prov) and s.amount = amt and s.due_date = due));
  return jsonb_build_object('id', existing_id, 'merged', merged);
end $$;
revoke execute on function yrols.yrols_save_invoice(jsonb) from public, anon;
grant execute on function yrols.yrols_save_invoice(jsonb) to authenticated, service_role;

-- Conferma di una proposta email: per le bollette passa da yrols_save_invoice (niente doppioni, PDF e voci inclusi).
create or replace function yrols.yrols_accept_suggestion(suggestion_id bigint, overrides jsonb default '{}'::jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare s yrols.email_suggestions; new_id bigint; amt numeric; due date; r jsonb;
begin
  select * into s from yrols.email_suggestions where id = suggestion_id for update;
  if not found then raise exception 'Proposta non trovata' using errcode = 'P0002'; end if;
  if s.status <> 'pending' then raise exception 'Proposta già gestita' using errcode = 'P0001'; end if;
  amt := coalesce(nullif(replace(overrides->>'amount', ',', '.'), '')::numeric, s.amount);
  due := coalesce(nullif(overrides->>'dueDate', '')::date, s.due_date);
  if due is null then raise exception 'Completa i dati: data di scadenza mancante'; end if;
  if s.kind = 'bill' then
    if amt is null then raise exception 'Completa i dati: importo mancante'; end if;
    r := yrols.yrols_save_invoice(jsonb_build_object(
      'provider', coalesce(nullif(overrides->>'provider', ''), s.provider, 'Fornitore'), 'kind', coalesce(s.bill_kind, 'altro'),
      'amount', amt, 'dueDate', due, 'periodFrom', s.period_from, 'periodTo', s.period_to,
      'invoiceNumber', s.invoice_number, 'issueDate', s.issue_date, 'items', s.items, 'filePath', s.file_path,
      'notes', 'Importata da email: ' || coalesce(s.subject, ''), 'source', 'email'));
    new_id := (r->>'id')::bigint;
  else
    insert into yrols.deadlines (title, category, amount, due_date, notes)
    values (coalesce(nullif(overrides->>'title', ''), s.title, 'Scadenza'), 'altro', amt, due, 'Importata da email: ' || coalesce(s.subject, ''))
    returning id into new_id;
  end if;
  update yrols.email_suggestions set status = 'accepted', created_id = new_id where id = s.id;
  return jsonb_build_object('id', new_id);
end $$;

-- Bucket privato per i PDF (solo dove esiste Supabase Storage; i test con PGlite non lo hanno).
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('yrols-fatture', 'yrols-fatture', false, 10485760, array['application/pdf'])
    on conflict (id) do nothing;
    execute $p$create policy "yrols fatture: lettura" on storage.objects for select to authenticated
      using (bucket_id = 'yrols-fatture' and yrols.yrols_is_member())$p$;
    execute $p$create policy "yrols fatture: caricamento" on storage.objects for insert to authenticated
      with check (bucket_id = 'yrols-fatture' and yrols.yrols_is_member())$p$;
    execute $p$create policy "yrols fatture: eliminazione" on storage.objects for delete to authenticated
      using (bucket_id = 'yrols-fatture' and yrols.yrols_is_member())$p$;
  end if;
end $$;
