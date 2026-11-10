-- Il rinnovo del consenso compare solo per le connessioni bancarie che hanno almeno un conto
-- (es. una banca collegata e poi abbandonata non deve generare promemoria).
create or replace function yrols.yrols_overview() returns jsonb
language sql stable set search_path = '' as $$
  with agenda as (
    select 'bill' as type, id::text as id, 'Bolletta ' || provider as title, due_date, amount from yrols.bills
      where paid_at is null and due_date <= current_date + 30
    union all
    select 'deadline', id::text, title, due_date, amount from yrols.deadlines
      where done_at is null and due_date <= current_date + 30
    union all
    select 'consent', id, 'Rinnova consenso ' || coalesce(bank_name, 'banca'), valid_until::date, null from yrols.bank_connections
      where valid_until is not null and valid_until::date <= current_date + 14
        and exists (select 1 from yrols.bank_accounts a where a.connection_id = bank_connections.id)
  )
  select jsonb_build_object(
    'netWorth', (select coalesce(round(sum(balance)::numeric, 2), 0)::float8 from yrols.yrols_accounts),
    'accountsCount', (select count(*) from yrols.bank_accounts),
    'last30', (select jsonb_build_object(
        'income', coalesce(sum(amount) filter (where amount > 0), 0)::float8,
        'expenses', coalesce(-sum(amount) filter (where amount < 0), 0)::float8)
      from yrols.bank_transactions where booking_date >= current_date - 30 and status = 'BOOK'),
    'monthly', (select coalesce(jsonb_agg(m order by m->>'month'), '[]'::jsonb) from (
        select jsonb_build_object('month', to_char(booking_date, 'YYYY-MM'),
          'income', coalesce(sum(amount) filter (where amount > 0), 0)::float8,
          'expenses', coalesce(-sum(amount) filter (where amount < 0), 0)::float8) m
        from yrols.bank_transactions
        where booking_date >= date_trunc('month', current_date - 185) and status = 'BOOK'
        group by to_char(booking_date, 'YYYY-MM')) s),
    'billsDueTotal', (select coalesce(sum(amount), 0)::float8 from agenda where type = 'bill'),
    'overdueCount', (select count(*) from agenda where due_date < current_date),
    'agenda', (select coalesce(jsonb_agg(jsonb_build_object('type', type, 'id', id, 'title', title, 'dueDate', due_date,
        'amount', amount::float8, 'overdue', due_date < current_date) order by due_date), '[]'::jsonb) from agenda),
    'reminders', (select coalesce(jsonb_agg(r), '[]'::jsonb) from (
        select jsonb_build_object('id', id, 'text', text, 'remindAt', remind_at, 'priority', priority) r
        from yrols.reminders where done_at is null
        order by remind_at is null, remind_at, case priority when 'alta' then 0 when 'normale' then 1 else 2 end limit 8) s),
    'billsByKind', (select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'total', total::float8) order by total desc), '[]'::jsonb)
        from (select kind, sum(amount) total from yrols.bills where due_date >= current_date - 365 group by kind) s),
    'history', yrols.yrols_history(180),
    'pendingEmail', (select count(*) from yrols.email_suggestions where status = 'pending')
  )
$$;
