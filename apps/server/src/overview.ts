import type { DB } from "./db.ts";
import { balanceHistory, listAccounts, round2 } from "./banks.ts";

const day = (offset = 0) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

export function overview(db: DB) {
  const today = day(), in30 = day(30), in14 = day(14), ago30 = day(-30);
  const accounts = listAccounts(db) as { balance: number | null }[];
  const netWorth = round2(accounts.reduce((s, a) => s + (a.balance ?? 0), 0));

  const flows = db.prepare(`SELECT COALESCE(SUM(CASE WHEN amount > 0 THEN amount END), 0) AS income,
      COALESCE(-SUM(CASE WHEN amount < 0 THEN amount END), 0) AS expenses
    FROM bank_transactions WHERE booking_date >= ? AND status = 'BOOK'`).get(ago30) as { income: number; expenses: number };

  const monthly = db.prepare(`SELECT substr(booking_date, 1, 7) AS month,
      ROUND(COALESCE(SUM(CASE WHEN amount > 0 THEN amount END), 0), 2) AS income,
      ROUND(COALESCE(-SUM(CASE WHEN amount < 0 THEN amount END), 0), 2) AS expenses
    FROM bank_transactions WHERE booking_date >= ? AND status = 'BOOK' GROUP BY month ORDER BY month`).all(day(-185).slice(0, 7) + "-01");

  const billsDue = db.prepare(`SELECT id, provider, kind, amount, due_date AS dueDate FROM bills
    WHERE paid_at IS NULL AND due_date <= ? ORDER BY due_date`).all(in30) as { amount: number; dueDate: string }[];
  const deadlinesDue = db.prepare(`SELECT id, title, category, amount, due_date AS dueDate FROM deadlines
    WHERE done_at IS NULL AND due_date <= ? ORDER BY due_date`).all(in30) as { dueDate: string }[];
  const consents = db.prepare(`SELECT id, bank_name AS bankName, valid_until AS validUntil FROM bank_connections
    WHERE valid_until IS NOT NULL AND substr(valid_until, 1, 10) <= ?`).all(in14) as { id: string; bankName: string | null; validUntil: string }[];
  const reminders = db.prepare(`SELECT id, text, remind_at AS remindAt, priority FROM reminders WHERE done_at IS NULL
    ORDER BY remind_at IS NULL, remind_at, CASE priority WHEN 'alta' THEN 0 WHEN 'normale' THEN 1 ELSE 2 END LIMIT 8`).all();
  const billsByKind = db.prepare(`SELECT kind, ROUND(SUM(amount), 2) AS total FROM bills WHERE due_date >= ? GROUP BY kind ORDER BY total DESC`).all(day(-365));
  const pendingEmail = (db.prepare(`SELECT COUNT(*) AS n FROM email_suggestions WHERE status = 'pending'`).get() as { n: number }).n;

  const agenda = [
    ...billsDue.map((b: any) => ({ type: "bill", id: b.id, title: `Bolletta ${b.provider}`, dueDate: b.dueDate, amount: b.amount, overdue: b.dueDate < today })),
    ...deadlinesDue.map((d: any) => ({ type: "deadline", id: d.id, title: d.title, dueDate: d.dueDate, amount: d.amount, overdue: d.dueDate < today })),
    ...consents.map((c) => ({ type: "consent", id: c.id, title: `Rinnova consenso ${c.bankName ?? "banca"}`, dueDate: c.validUntil.slice(0, 10), amount: null, overdue: c.validUntil.slice(0, 10) < today })),
  ].sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  return {
    netWorth,
    accountsCount: accounts.length,
    last30: { income: round2(flows.income), expenses: round2(flows.expenses) },
    billsDueTotal: round2(billsDue.reduce((s, b) => s + b.amount, 0)),
    overdueCount: agenda.filter((a) => a.overdue).length,
    agenda,
    reminders,
    monthly,
    billsByKind,
    history: balanceHistory(db, 180),
    pendingEmail,
  };
}
