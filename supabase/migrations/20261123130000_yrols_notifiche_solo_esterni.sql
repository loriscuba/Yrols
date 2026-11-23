-- Notifiche dei movimenti solo per addebiti e accrediti esterni (richiesta di Loris, 23 nov 2026).
-- I giroconti tra i propri conti restano tra i movimenti ma non generano notifiche. Un movimento è interno se:
--   • sull'altro conto collegato c'è l'importo opposto entro 3 giorni (es. conto personale ↔ conto cointestato);
--   • è uno spostamento tra salvadanai Revolut ("To …"/"From …" senza controparte);
--   • è una ricarica Revolut con la propria carta ("Top-Up"), o il suo addebito su Fineco ("Revolut**…");
--   • è un giroconto o il saldo della propria carta di credito.
-- Il trigger parte a fine transazione, così vede anche l'altra metà del giroconto arrivata nella stessa lettura.
-- Se l'altra metà arriva dopo (un'altra banca), la notifica già creata per la prima metà viene tolta dall'elenco.

create function yrols.yrols_tx_internal(acc text, amt numeric, day date, descr text, cp text) returns boolean
language sql stable security definer set search_path = '' as $$
  select (coalesce(trim(cp), '') = '' and coalesce(descr, '') ~ '(^|\s)(To|From) \S')
      or coalesce(descr, '') ~* '(top-up|^revolut\*|^giroconto|estratto conto.*carta di credito)'
      or exists (select 1 from yrols.bank_transactions o
                 where o.account_id <> acc and o.amount = -amt and abs(o.booking_date - day) <= 3)
$$;

create or replace function yrols.yrols_notify_tx() returns trigger
language plpgsql security definer set search_path = '' as $$
declare bank text; label text; o record;
begin
  if new.booking_date < current_date - 4 then return null; end if;
  if not exists (select 1 from yrols.bank_transactions where account_id = new.account_id and id = new.id) then return null; end if;
  if yrols.yrols_tx_internal(new.account_id, new.amount, new.booking_date, new.description, new.counterparty) then
    -- Giroconto: toglie la notifica dell'altra metà, se era già arrivata.
    for o in select account_id, amount from yrols.bank_transactions
             where account_id <> new.account_id and amount = -new.amount and abs(booking_date - new.booking_date) <= 3 loop
      delete from yrols.notifications where kind = 'movimento' and created_at > now() - interval '7 days'
        and dedup like 'tx:' || o.account_id || ':' || o.amount::text || ':%';
    end loop;
    return null;
  end if;
  select coalesce(bank_name, name) into bank from yrols.bank_accounts where id = new.account_id;
  label := left(coalesce(nullif(trim(new.counterparty), ''), nullif(trim(new.description), ''), 'Movimento'), 80);
  if exists (select 1 from yrols.notifications where kind = 'movimento' and created_at > now() - interval '7 days'
             and dedup like 'tx:' || new.account_id || ':' || new.amount::text || ':' || md5(label) || ':%') then
    return null;
  end if;
  perform yrols.yrols_notify('movimento',
    case when new.amount < 0 then 'Uscita ' else 'Entrata ' end || yrols.yrols_eur(abs(new.amount)),
    label || coalesce(' · ' || bank, '') || case when new.status = 'PDNG' then ' · in attesa' else '' end,
    '/banche', 'tx:' || new.account_id || ':' || new.amount::text || ':' || md5(label) || ':' || new.id);
  return null;
end $$;

drop trigger bank_transactions_notify on yrols.bank_transactions;
create constraint trigger bank_transactions_notify after insert on yrols.bank_transactions
  deferrable initially deferred for each row execute function yrols.yrols_notify_tx();

revoke execute on function yrols.yrols_tx_internal(text, numeric, date, text, text) from public, anon, authenticated;
