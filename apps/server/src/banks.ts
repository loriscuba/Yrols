import { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import type { DB } from "./db.ts";
import { tx } from "./db.ts";

/** Contratto v1 — vedi docs/contratto-dati-banche.md */
export interface SyncPayload {
  source?: string;
  syncedAt?: string;
  connections?: { id: string; bankName?: string; country?: string; validUntil?: string; status?: string }[];
  accounts?: { id: string; iban?: string; name?: string; currency?: string; bankName?: string; connectionId?: string }[];
  balances?: { accountId: string; amount: number; currency?: string; type?: string; date?: string }[];
  transactions?: {
    id: string; accountId: string; amount: number; currency?: string; bookingDate: string;
    valueDate?: string; description?: string; counterparty?: string; status?: string;
  }[];
}

export class ValidationError extends Error {}

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v);

function arr(p: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const v = p[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new ValidationError(`${key} deve essere un array`);
  v.forEach((item, i) => {
    if (typeof item !== "object" || item === null) throw new ValidationError(`${key}[${i}] deve essere un oggetto`);
  });
  return v as Record<string, unknown>[];
}

export function validateSync(body: unknown): SyncPayload {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ValidationError("corpo JSON mancante");
  const p = body as Record<string, unknown>;
  arr(p, "connections").forEach((c, i) => { if (!isStr(c.id)) throw new ValidationError(`connections[${i}].id obbligatorio`); });
  arr(p, "accounts").forEach((a, i) => { if (!isStr(a.id)) throw new ValidationError(`accounts[${i}].id obbligatorio`); });
  arr(p, "balances").forEach((b, i) => {
    if (!isStr(b.accountId)) throw new ValidationError(`balances[${i}].accountId obbligatorio`);
    if (!isNum(b.amount)) throw new ValidationError(`balances[${i}].amount deve essere un numero`);
    if (b.date !== undefined && !isDate(b.date)) throw new ValidationError(`balances[${i}].date non valida`);
  });
  arr(p, "transactions").forEach((t, i) => {
    if (!isStr(t.id)) throw new ValidationError(`transactions[${i}].id obbligatorio`);
    if (!isStr(t.accountId)) throw new ValidationError(`transactions[${i}].accountId obbligatorio`);
    if (!isNum(t.amount)) throw new ValidationError(`transactions[${i}].amount deve essere un numero`);
    if (!isDate(t.bookingDate)) throw new ValidationError(`transactions[${i}].bookingDate non valida`);
  });
  return p as SyncPayload;
}

export function applySync(db: DB, p: SyncPayload) {
  const now = new Date().toISOString();
  const syncedAt = p.syncedAt ?? now;
  const syncDay = syncedAt.slice(0, 10);
  const c = p.connections ?? [], a = p.accounts ?? [], b = p.balances ?? [], t = p.transactions ?? [];

  return tx(db, () => {
    const upConn = db.prepare(`INSERT INTO bank_connections (id, bank_name, country, valid_until, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      bank_name = COALESCE(excluded.bank_name, bank_name), country = COALESCE(excluded.country, country),
      valid_until = COALESCE(excluded.valid_until, valid_until), status = COALESCE(excluded.status, status),
      updated_at = excluded.updated_at`);
    for (const x of c) upConn.run(x.id, x.bankName ?? null, x.country ?? null, x.validUntil ?? null, x.status ?? null, now);

    const upAcc = db.prepare(`INSERT INTO bank_accounts (id, connection_id, bank_name, name, iban, currency, source, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      connection_id = COALESCE(excluded.connection_id, connection_id), bank_name = COALESCE(excluded.bank_name, bank_name),
      name = COALESCE(excluded.name, name), iban = COALESCE(excluded.iban, iban), currency = excluded.currency,
      source = COALESCE(excluded.source, source), updated_at = excluded.updated_at`);
    for (const x of a) upAcc.run(x.id, x.connectionId ?? null, x.bankName ?? null, x.name ?? null, x.iban ?? null, x.currency ?? "EUR", p.source ?? null, now);

    // Un saldo può riferirsi a un conto non elencato in questa sync: crealo al volo.
    const ensureAcc = db.prepare(`INSERT OR IGNORE INTO bank_accounts (id, currency, source, updated_at) VALUES (?, ?, ?, ?)`);
    const upBal = db.prepare(`INSERT INTO bank_balances (account_id, type, date, amount, currency) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account_id, type, date) DO UPDATE SET amount = excluded.amount, currency = excluded.currency`);
    for (const x of b) {
      ensureAcc.run(x.accountId, x.currency ?? "EUR", p.source ?? null, now);
      upBal.run(x.accountId, x.type ?? "OTHR", (x.date ?? syncDay).slice(0, 10), x.amount, x.currency ?? "EUR");
    }

    const upTx = db.prepare(`INSERT INTO bank_transactions (id, account_id, amount, currency, booking_date, value_date, description, counterparty, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, id) DO UPDATE SET
      amount = excluded.amount, currency = excluded.currency, booking_date = excluded.booking_date, value_date = excluded.value_date,
      description = excluded.description, counterparty = excluded.counterparty, status = excluded.status`);
    for (const x of t) {
      ensureAcc.run(x.accountId, x.currency ?? "EUR", p.source ?? null, now);
      upTx.run(x.id, x.accountId, x.amount, x.currency ?? "EUR", x.bookingDate.slice(0, 10), x.valueDate?.slice(0, 10) ?? null,
        x.description ?? null, x.counterparty ?? null, x.status ?? "BOOK");
    }

    const summary = { connections: c.length, accounts: a.length, balances: b.length, transactions: t.length };
    db.prepare(`INSERT INTO bank_syncs (source, synced_at, received_at, summary) VALUES (?, ?, ?, ?)`)
      .run(p.source ?? null, syncedAt, now, JSON.stringify(summary));
    return summary;
  });
}

/** Saldo "corrente" per conto: preferenza ITAV > CLAV > XPCD > CLBD > altri, poi data più recente. */
const CURRENT_BALANCE_SQL = `
  SELECT account_id, amount, currency, type, date FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY date DESC,
      CASE type WHEN 'ITAV' THEN 0 WHEN 'CLAV' THEN 1 WHEN 'XPCD' THEN 2 WHEN 'CLBD' THEN 3 ELSE 4 END) AS rn
    FROM bank_balances) WHERE rn = 1`;

export function listAccounts(db: DB) {
  return db.prepare(`SELECT a.id, a.name, a.bank_name AS bankName, a.iban, a.currency, a.connection_id AS connectionId,
      a.updated_at AS updatedAt, b.amount AS balance, b.type AS balanceType, b.date AS balanceDate
    FROM bank_accounts a LEFT JOIN (${CURRENT_BALANCE_SQL}) b ON b.account_id = a.id
    ORDER BY a.bank_name, a.name`).all();
}

/** Patrimonio totale per giorno, portando avanti l'ultimo saldo noto di ogni conto. */
export function balanceHistory(db: DB, days = 180) {
  const rows = db.prepare(`SELECT account_id, date, amount FROM (
      SELECT account_id, date, amount, ROW_NUMBER() OVER (PARTITION BY account_id, date ORDER BY
        CASE type WHEN 'ITAV' THEN 0 WHEN 'CLAV' THEN 1 WHEN 'XPCD' THEN 2 WHEN 'CLBD' THEN 3 ELSE 4 END) rn
      FROM bank_balances) WHERE rn = 1 ORDER BY date`).all() as { account_id: string; date: string; amount: number }[];
  if (rows.length === 0) return [];
  const dates = [...new Set(rows.map((r) => r.date))].sort();
  const cutoff = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const last = new Map<string, number>();
  const out: { date: string; total: number }[] = [];
  let i = 0;
  for (const d of dates) {
    while (i < rows.length && rows[i].date === d) { last.set(rows[i].account_id, rows[i].amount); i++; }
    if (d >= cutoff) out.push({ date: d, total: round2([...last.values()].reduce((s, v) => s + v, 0)) });
  }
  return out;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

function tokenOk(header: string | undefined, token: string) {
  const got = Buffer.from(header?.replace(/^Bearer\s+/i, "") ?? "");
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

export function banksRouter(db: DB, ingestToken: string | undefined, onSync?: () => void) {
  const r = Router();

  r.post("/sync", (req, res) => {
    if (!ingestToken) return res.status(503).json({ ok: false, error: "YROLS_INGEST_TOKEN non configurato sul server" });
    if (!tokenOk(req.headers.authorization, ingestToken)) return res.status(401).json({ ok: false, error: "token non valido" });
    try {
      const payload = validateSync(req.body);
      const summary = applySync(db, payload);
      onSync?.();
      res.json({ ok: true, ...summary });
    } catch (e) {
      if (e instanceof ValidationError) return res.status(400).json({ ok: false, error: e.message });
      throw e;
    }
  });

  r.get("/accounts", (_req, res) => { res.json(listAccounts(db)); });

  r.get("/connections", (_req, res) => {
    res.json(db.prepare(`SELECT id, bank_name AS bankName, country, valid_until AS validUntil, status, updated_at AS updatedAt
      FROM bank_connections ORDER BY valid_until`).all());
  });

  r.get("/transactions", (req, res) => {
    const where: string[] = [], args: (string | number)[] = [];
    const q = req.query as Record<string, string | undefined>;
    if (q.accountId) { where.push("t.account_id = ?"); args.push(q.accountId); }
    if (q.from) { where.push("t.booking_date >= ?"); args.push(q.from); }
    if (q.to) { where.push("t.booking_date <= ?"); args.push(q.to); }
    if (q.q) { where.push("(t.description LIKE ? OR t.counterparty LIKE ?)"); args.push(`%${q.q}%`, `%${q.q}%`); }
    const limit = Math.min(Number(q.limit) || 200, 2000);
    res.json(db.prepare(`SELECT t.id, t.account_id AS accountId, t.amount, t.currency, t.booking_date AS bookingDate,
        t.value_date AS valueDate, t.description, t.counterparty, t.status, a.name AS accountName, a.bank_name AS bankName
      FROM bank_transactions t LEFT JOIN bank_accounts a ON a.id = t.account_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY t.booking_date DESC, t.rowid DESC LIMIT ${limit}`).all(...args));
  });

  r.get("/history", (req, res) => { res.json(balanceHistory(db, Number(req.query.days) || 180)); });

  r.get("/last-sync", (_req, res) => {
    res.json(db.prepare(`SELECT source, synced_at AS syncedAt, received_at AS receivedAt, summary FROM bank_syncs ORDER BY id DESC LIMIT 1`).get() ?? null);
  });

  return r;
}
