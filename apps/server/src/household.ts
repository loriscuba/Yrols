import { Router, type Request } from "express";
import type { DB } from "./db.ts";

type Field = { name: string; col: string; type: "string" | "number" | "boolean" | "date" | "datetime"; required?: boolean; enum?: string[] };

export const BILL_KINDS = ["luce", "gas", "acqua", "internet", "telefono", "rifiuti", "condominio", "affitto", "mutuo", "altro"];
export const DEADLINE_CATEGORIES = ["casa", "auto", "tasse", "assicurazione", "salute", "documenti", "abbonamenti", "scuola", "altro"];
export const RECURRENCES = ["none", "monthly", "bimonthly", "quarterly", "semiannual", "yearly"];
export const PRIORITIES = ["bassa", "normale", "alta"];
export const SUPPLIER_STATUSES = ["attivo", "nascosto"];

export const RESOURCES: Record<string, { table: string; order: string; fields: Field[] }> = {
  bills: {
    table: "bills",
    order: "paid_at IS NOT NULL, due_date",
    fields: [
      { name: "provider", col: "provider", type: "string", required: true },
      { name: "kind", col: "kind", type: "string", enum: BILL_KINDS },
      { name: "amount", col: "amount", type: "number", required: true },
      { name: "dueDate", col: "due_date", type: "date", required: true },
      { name: "periodFrom", col: "period_from", type: "date" },
      { name: "periodTo", col: "period_to", type: "date" },
      { name: "paidAt", col: "paid_at", type: "date" },
      { name: "notes", col: "notes", type: "string" },
    ],
  },
  deadlines: {
    table: "deadlines",
    order: "done_at IS NOT NULL, due_date",
    fields: [
      { name: "title", col: "title", type: "string", required: true },
      { name: "category", col: "category", type: "string", enum: DEADLINE_CATEGORIES },
      { name: "dueDate", col: "due_date", type: "date", required: true },
      { name: "amount", col: "amount", type: "number" },
      { name: "recurrence", col: "recurrence", type: "string", enum: RECURRENCES },
      { name: "doneAt", col: "done_at", type: "date" },
      { name: "notes", col: "notes", type: "string" },
    ],
  },
  suppliers: {
    table: "suppliers",
    order: "name COLLATE NOCASE",
    fields: [
      { name: "key", col: "key", type: "string", required: true },
      { name: "name", col: "name", type: "string", required: true },
      { name: "kind", col: "kind", type: "string", enum: BILL_KINDS },
      { name: "status", col: "status", type: "string", enum: SUPPLIER_STATUSES },
      { name: "monthly", col: "monthly", type: "number" },
      { name: "directDebit", col: "direct_debit", type: "boolean" },
      { name: "customerCode", col: "customer_code", type: "string" },
      { name: "contractCode", col: "contract_code", type: "string" },
      { name: "website", col: "website", type: "string" },
      { name: "phone", col: "phone", type: "string" },
      { name: "notes", col: "notes", type: "string" },
    ],
  },
  reminders: {
    table: "reminders",
    order: "done_at IS NOT NULL, remind_at IS NULL, remind_at, id DESC",
    fields: [
      { name: "text", col: "text", type: "string", required: true },
      { name: "remindAt", col: "remind_at", type: "datetime" },
      { name: "priority", col: "priority", type: "string", enum: PRIORITIES },
      { name: "doneAt", col: "done_at", type: "datetime" },
    ],
  },
};

export class BadInput extends Error {}

function parse(fields: Field[], body: Record<string, unknown>, partial: boolean) {
  const out: Record<string, string | number | null> = {};
  for (const f of fields) {
    if (!(f.name in body)) {
      if (f.required && !partial) throw new BadInput(`${f.name} obbligatorio`);
      continue;
    }
    let v = body[f.name];
    if (v === "" || v === undefined) v = null;
    if (v === null) {
      if (f.required) throw new BadInput(`${f.name} obbligatorio`);
      out[f.col] = null;
      continue;
    }
    if (f.type === "boolean") {
      if (typeof v !== "boolean") throw new BadInput(`${f.name} deve essere vero o falso`);
      out[f.col] = v ? 1 : 0;
    } else if (f.type === "number") {
      const n = typeof v === "string" ? Number(v.replace(",", ".")) : v;
      if (typeof n !== "number" || !Number.isFinite(n)) throw new BadInput(`${f.name} deve essere un numero`);
      out[f.col] = n;
    } else {
      if (typeof v !== "string") throw new BadInput(`${f.name} deve essere un testo`);
      if (f.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new BadInput(`${f.name} deve essere AAAA-MM-GG`);
      if (f.type === "datetime" && Number.isNaN(Date.parse(v))) throw new BadInput(`${f.name} non è una data valida`);
      if (f.enum && !f.enum.includes(v)) throw new BadInput(`${f.name} deve essere uno tra: ${f.enum.join(", ")}`);
      out[f.col] = v.trim();
    }
  }
  return out;
}

function selectCols(fields: Field[]) {
  return ["id", ...fields.map((f) => (f.col === f.name ? f.col : `${f.col} AS ${f.name}`)), "created_at AS createdAt"].join(", ");
}

/** Prossima data per una scadenza ricorrente. Fine mese gestita (31 gen + 1 mese = 28/29 feb). */
export function nextDate(date: string, recurrence: string): string | null {
  const months = { monthly: 1, bimonthly: 2, quarterly: 3, semiannual: 6, yearly: 12 }[recurrence];
  if (!months) return null;
  const [y, m, d] = date.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

export function insertRow(db: DB, resource: string, body: Record<string, unknown>) {
  const def = RESOURCES[resource];
  const data = parse(def.fields, body, false);
  const cols = [...Object.keys(data), "created_at"];
  const vals = [...Object.values(data), new Date().toISOString()];
  const r = db.prepare(`INSERT INTO ${def.table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...vals);
  return getRow(db, resource, Number(r.lastInsertRowid));
}

export function getRow(db: DB, resource: string, id: number) {
  const def = RESOURCES[resource];
  return db.prepare(`SELECT ${selectCols(def.fields)} FROM ${def.table} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
}

export function householdRouter(db: DB) {
  const r = Router();
  const id = (req: Request) => Number(req.params.id);

  for (const [name, def] of Object.entries(RESOURCES)) {
    r.get(`/${name}`, (_req, res) => {
      res.json(db.prepare(`SELECT ${selectCols(def.fields)} FROM ${def.table} ORDER BY ${def.order}`).all());
    });

    r.post(`/${name}`, (req, res) => { res.status(201).json(insertRow(db, name, req.body ?? {})); });

    r.patch(`/${name}/:id`, (req, res) => {
      const before = getRow(db, name, id(req));
      if (!before) return res.status(404).json({ error: "non trovato" });
      const data = parse(def.fields, req.body ?? {}, true);
      const keys = Object.keys(data);
      if (keys.length) db.prepare(`UPDATE ${def.table} SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...Object.values(data), id(req));
      const after = getRow(db, name, id(req))!;

      // Scadenza ricorrente completata: crea la prossima occorrenza.
      let next = null;
      if (name === "deadlines" && !before.doneAt && after.doneAt && after.recurrence !== "none") {
        const due = nextDate(String(after.dueDate), String(after.recurrence));
        if (due) next = insertRow(db, "deadlines", { ...after, dueDate: due, doneAt: null });
      }
      res.json(next ? { ...after, next } : after);
    });

    r.delete(`/${name}/:id`, (req, res) => {
      const out = db.prepare(`DELETE FROM ${def.table} WHERE id = ?`).run(id(req));
      if (!out.changes) return res.status(404).json({ error: "non trovato" });
      res.status(204).end();
    });
  }

  r.get("/meta", (_req, res) => {
    res.json({ billKinds: BILL_KINDS, deadlineCategories: DEADLINE_CATEGORIES, recurrences: RECURRENCES, priorities: PRIORITIES });
  });

  return r;
}

/**
 * Segna come pagate le bollette che trovano un addebito corrispondente:
 * stesso importo (al centesimo), entro 20 giorni dalla scadenza e fornitore citato nel movimento.
 */
export function matchBillsWithTransactions(db: DB) {
  const bills = db.prepare(`SELECT id, provider, amount, due_date FROM bills WHERE paid_at IS NULL`).all() as
    { id: number; provider: string; amount: number; due_date: string }[];
  const find = db.prepare(`SELECT booking_date FROM bank_transactions
    WHERE ROUND(amount, 2) = ROUND(?, 2) AND ABS(julianday(booking_date) - julianday(?)) <= 20
      AND (LOWER(COALESCE(description, '') || ' ' || COALESCE(counterparty, '')) LIKE ?)
    ORDER BY ABS(julianday(booking_date) - julianday(?)) LIMIT 1`);
  const mark = db.prepare(`UPDATE bills SET paid_at = ?, notes = TRIM(COALESCE(notes, '') || ' [pagata: addebito trovato in banca]') WHERE id = ?`);
  let matched = 0;
  for (const b of bills) {
    const word = b.provider.toLowerCase().split(/\s+/)[0];
    const hit = find.get(-Math.abs(b.amount), b.due_date, `%${word}%`, b.due_date) as { booking_date: string } | undefined;
    if (hit) { mark.run(hit.booking_date, b.id); matched++; }
  }
  return matched;
}
