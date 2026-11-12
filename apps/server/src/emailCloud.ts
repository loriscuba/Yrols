/**
 * Lettura email per la versione online (GitHub Actions): legge la posta e salva le proposte di
 * bollette/scadenze in Supabase. Se la mail ha una fattura PDF allegata ne legge i dati e la salva
 * nel bucket privato "yrols-fatture", così dal cruscotto si apre il PDF. Nei log stampa solo conteggi, mai contenuti né indirizzi
 * (i log di Actions di un repo pubblico sono pubblici).
 *
 * Sorgente, in ordine:
 *  1. Gmail collegata dal cruscotto (Google OAuth in sola lettura): l'access token di un'ora lo
 *     fornisce la Edge Function yrols-email-auth, che sola conosce il client secret Google.
 *  2. In alternativa, casella IMAP dai secret YROLS_IMAP_* (altri provider).
 */
import { createHash } from "node:crypto";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { imapConfigFromEnv, readMailbox } from "./email.ts";
import type { ParsedEmail } from "./emailParser.ts";
import { readGmail } from "./gmail.ts";
import { analyzeEmail } from "./invoiceEmail.ts";
import type { GetDocument } from "./pdfText.ts";

const url = process.env.SUPABASE_URL?.replace(/\/+$/, "");
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const cfg = imapConfigFromEnv();
const sinceDays = Number(process.env.YROLS_IMAP_SINCE_DAYS) || 30;
const maxMessages = Number(process.env.YROLS_IMAP_MAX) || 300;
if (!url || !key) { console.log("Supabase non configurato (secret SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY): niente da fare."); process.exit(0); }

/** Access token Gmail dalla Edge Function; null se nessuna Gmail è collegata. */
async function gmailToken(): Promise<string | null> {
  const res = await fetch(`${url}/functions/v1/yrols-email-auth`, {
    method: "POST", headers: { Authorization: `Bearer ${key}`, apikey: key!, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "token" }),
  });
  if (res.status === 404) return null;
  const body = await res.json().catch(() => ({})) as { accessToken?: string; error?: string };
  if (res.status === 409) { console.log("Accesso Gmail scaduto o revocato: ricollega la casella dal cruscotto."); process.exit(0); }
  if (!res.ok || !body.accessToken) throw new Error(`Token Gmail non ottenuto (${res.status})`);
  return body.accessToken;
}

let source: (seen: Set<string>) => AsyncGenerator<{ messageId: string; email: ParsedEmail }>;
const token = await gmailToken();
if (token) source = (seen) => readGmail(token, { sinceDays, maxMessages }, seen);
else if (cfg) source = (seen) => readMailbox(cfg, seen);
else { console.log("Nessuna casella collegata (Gmail dal cruscotto o secret YROLS_IMAP_*): niente da fare."); process.exit(0); }

// Le tabelle stanno nello schema "yrols" del progetto Supabase.
const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Accept-Profile": "yrols", "Content-Profile": "yrols" };
async function rest(path: string, init: RequestInit = {}) {
  const res = await fetch(`${url}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  if (!res.ok) throw new Error(`Supabase ${res.status} su ${path.split("?")[0]}`);
  return res.status === 204 || res.status === 201 ? null : res.json();
}

const existing = (await rest("email_suggestions?select=message_id")) as { message_id: string }[];
const seen = new Set(existing.map((r) => r.message_id));
/** Carica il PDF nel bucket privato; il nome è un hash del messaggio (niente dati personali nel percorso). */
async function uploadPdf(messageId: string, content: Uint8Array): Promise<string | null> {
  const path = `email/${createHash("sha256").update(messageId).digest("hex").slice(0, 32)}.pdf`;
  const res = await fetch(`${url}/storage/v1/object/yrols-fatture/${path}`, {
    method: "POST", headers: { apikey: key!, Authorization: `Bearer ${key}`, "Content-Type": "application/pdf", "x-upsert": "true" },
    body: new Blob([content.slice()], { type: "application/pdf" }),
  });
  return res.ok ? path : null;
}

let scanned = 0, pdfs = 0;
const rows: Record<string, unknown>[] = [];
for await (const { messageId, email } of source(seen)) {
  scanned++;
  const s = await analyzeEmail(email, getDocument as unknown as GetDocument);
  if (!s) continue;
  const filePath = s.pdf ? await uploadPdf(messageId, s.pdf.content) : null;
  if (filePath) pdfs++;
  rows.push({
    message_id: messageId, sender: email.from, subject: email.subject, received_at: email.date?.toISOString() ?? null,
    kind: s.kind, provider: s.provider, bill_kind: s.billKind, title: s.title, amount: s.amount, due_date: s.dueDate, snippet: s.snippet,
    invoice_number: s.invoiceNumber, issue_date: s.issueDate, period_from: s.periodFrom, period_to: s.periodTo, items: s.items, file_path: filePath,
  });
}
if (rows.length) {
  await rest("email_suggestions?on_conflict=message_id", {
    method: "POST", body: JSON.stringify(rows), headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
  });
}
const now = new Date().toISOString();
await rest("bank_syncs", { method: "POST", body: JSON.stringify({ source: "email", synced_at: now, summary: { scanned, found: rows.length, pdfs } }), headers: { Prefer: "return=minimal" } });
console.log(`Email lette: ${scanned}, nuove proposte: ${rows.length}, fatture PDF: ${pdfs}`);
