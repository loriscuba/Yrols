import { Router } from "express";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { DB } from "./db.ts";
import { parseEmail, type ParsedEmail } from "./emailParser.ts";
import { insertRow, BadInput } from "./household.ts";

export interface ImapConfig {
  host: string; port: number; secure: boolean; user: string; password: string;
  mailbox: string; sinceDays: number; maxMessages: number;
}

export function imapConfigFromEnv(env = process.env): ImapConfig | null {
  if (!env.YROLS_IMAP_HOST || !env.YROLS_IMAP_USER || !env.YROLS_IMAP_PASSWORD) return null;
  return {
    host: env.YROLS_IMAP_HOST,
    port: Number(env.YROLS_IMAP_PORT) || 993,
    secure: env.YROLS_IMAP_SECURE !== "false",
    user: env.YROLS_IMAP_USER,
    password: env.YROLS_IMAP_PASSWORD,
    mailbox: env.YROLS_IMAP_MAILBOX || "INBOX",
    sinceDays: Number(env.YROLS_IMAP_SINCE_DAYS) || 60,
    maxMessages: Number(env.YROLS_IMAP_MAX) || 300,
  };
}

/** Salva un suggerimento (ignora email già viste). Ritorna true se è nuovo. */
export function storeSuggestion(db: DB, messageId: string, e: ParsedEmail): boolean {
  const s = parseEmail(e);
  if (!s) return false;
  const r = db.prepare(`INSERT OR IGNORE INTO email_suggestions
    (message_id, sender, subject, received_at, kind, provider, bill_kind, title, amount, due_date, snippet, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    messageId, e.from, e.subject, e.date?.toISOString() ?? null, s.kind, s.provider, s.billKind, s.title,
    s.amount, s.dueDate, s.snippet, new Date().toISOString());
  return r.changes > 0;
}

/** Legge le email recenti della casella e restituisce quelle non ancora viste. Condiviso da server locale e GitHub Actions. */
export async function* readMailbox(cfg: ImapConfig, seen: Set<string>): AsyncGenerator<{ messageId: string; email: ParsedEmail }> {
  const client = new ImapFlow({
    host: cfg.host, port: cfg.port, secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.password }, logger: false,
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock(cfg.mailbox);
    try {
      const since = new Date(Date.now() - cfg.sinceDays * 864e5);
      const uids = (await client.search({ since }, { uid: true })) || [];
      const recent = uids.slice(-cfg.maxMessages);
      if (recent.length === 0) return;
      for await (const msg of client.fetch(recent, { uid: true, envelope: true, source: true }, { uid: true })) {
        const messageId = msg.envelope?.messageId || `uid:${cfg.mailbox}:${msg.uid}`;
        if (seen.has(messageId) || !msg.source) continue;
        const parsed = await simpleParser(msg.source);
        const text = parsed.text || (typeof parsed.html === "string" ? parsed.html.replace(/<[^>]+>/g, " ") : "");
        yield { messageId, email: { from: parsed.from?.text ?? "", subject: parsed.subject ?? "", text, date: parsed.date } };
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } finally {
    client.close();
  }
}

let scanning = false;

export async function scanMailbox(db: DB, cfg: ImapConfig) {
  if (scanning) return { skipped: true, scanned: 0, found: 0 };
  scanning = true;
  let scanned = 0, found = 0;
  try {
    const seen = new Set((db.prepare(`SELECT message_id FROM email_suggestions`).all() as { message_id: string }[]).map((r) => r.message_id));
    for await (const m of readMailbox(cfg, seen)) {
      scanned++;
      if (storeSuggestion(db, m.messageId, m.email)) found++;
    }
  } finally {
    scanning = false;
  }
  db.prepare(`INSERT INTO bank_syncs (source, synced_at, received_at, summary) VALUES ('email', ?, ?, ?)`)
    .run(new Date().toISOString(), new Date().toISOString(), JSON.stringify({ scanned, found }));
  return { skipped: false, scanned, found };
}

export function emailRouter(db: DB, cfg: ImapConfig | null) {
  const r = Router();
  const cols = `id, sender, subject, received_at AS receivedAt, kind, provider, bill_kind AS billKind, title, amount,
    due_date AS dueDate, snippet, status, created_id AS createdId`;

  r.get("/status", (_req, res) => {
    const last = db.prepare(`SELECT received_at AS at, summary FROM bank_syncs WHERE source = 'email' ORDER BY id DESC LIMIT 1`).get();
    res.json({ configured: !!cfg, user: cfg?.user ?? null, host: cfg?.host ?? null, lastScan: last ?? null });
  });

  r.post("/scan", async (_req, res) => {
    if (!cfg) return res.status(503).json({ error: "Casella email non configurata (YROLS_IMAP_*)" });
    try {
      res.json(await scanMailbox(db, cfg));
    } catch (e) {
      res.status(502).json({ error: `Lettura email non riuscita: ${(e as Error).message}` });
    }
  });

  r.get("/suggestions", (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : "pending";
    res.json(db.prepare(`SELECT ${cols} FROM email_suggestions WHERE status = ? ORDER BY COALESCE(due_date, received_at) DESC`).all(status));
  });

  /** Conferma: crea la bolletta o la scadenza; il corpo può correggere i campi riconosciuti. */
  r.post("/suggestions/:id/accept", (req, res) => {
    const s = db.prepare(`SELECT ${cols} FROM email_suggestions WHERE id = ?`).get(Number(req.params.id)) as any;
    if (!s) return res.status(404).json({ error: "non trovato" });
    if (s.status !== "pending") return res.status(409).json({ error: "già gestito" });
    const o = req.body ?? {};
    const note = `Importata da email: ${s.subject ?? ""}`.trim();
    try {
      const row = s.kind === "bill"
        ? insertRow(db, "bills", { provider: o.provider ?? s.provider ?? "Fornitore", kind: o.kind ?? s.billKind ?? "altro",
            amount: o.amount ?? s.amount, dueDate: o.dueDate ?? s.dueDate, notes: note })
        : insertRow(db, "deadlines", { title: o.title ?? s.title, category: o.category ?? "altro",
            amount: o.amount ?? s.amount, dueDate: o.dueDate ?? s.dueDate, notes: note });
      db.prepare(`UPDATE email_suggestions SET status = 'accepted', created_id = ? WHERE id = ?`).run(row!.id as number, s.id);
      res.status(201).json(row);
    } catch (e) {
      if (e instanceof BadInput) return res.status(400).json({ error: `Completa i dati: ${e.message}` });
      throw e;
    }
  });

  r.post("/suggestions/:id/dismiss", (req, res) => {
    const out = db.prepare(`UPDATE email_suggestions SET status = 'dismissed' WHERE id = ? AND status = 'pending'`).run(Number(req.params.id));
    res.status(out.changes ? 204 : 404).end();
  });

  return r;
}
