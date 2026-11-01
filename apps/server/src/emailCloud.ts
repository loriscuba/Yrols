/**
 * Lettura email per la versione online (GitHub Actions): legge la casella via IMAP e salva
 * le proposte di bollette/scadenze in Supabase. Nei log stampa solo conteggi, mai contenuti
 * (i log di Actions di un repo pubblico sono pubblici).
 */
import { imapConfigFromEnv, readMailbox } from "./email.ts";
import { parseEmail } from "./emailParser.ts";

const url = process.env.SUPABASE_URL?.replace(/\/+$/, "");
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const cfg = imapConfigFromEnv();
if (!url || !key) { console.log("Supabase non configurato (secret SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY): niente da fare."); process.exit(0); }
if (!cfg) { console.log("Casella email non configurata (secret YROLS_IMAP_*): niente da fare."); process.exit(0); }

const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
async function rest(path: string, init: RequestInit = {}) {
  const res = await fetch(`${url}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  if (!res.ok) throw new Error(`Supabase ${res.status} su ${path.split("?")[0]}`);
  return res.status === 204 || res.status === 201 ? null : res.json();
}

const existing = (await rest("email_suggestions?select=message_id")) as { message_id: string }[];
const seen = new Set(existing.map((r) => r.message_id));
let scanned = 0;
const rows: Record<string, unknown>[] = [];
for await (const { messageId, email } of readMailbox(cfg, seen)) {
  scanned++;
  const s = parseEmail(email);
  if (!s) continue;
  rows.push({
    message_id: messageId, sender: email.from, subject: email.subject, received_at: email.date?.toISOString() ?? null,
    kind: s.kind, provider: s.provider, bill_kind: s.billKind, title: s.title, amount: s.amount, due_date: s.dueDate, snippet: s.snippet,
  });
}
if (rows.length) {
  await rest("email_suggestions?on_conflict=message_id", {
    method: "POST", body: JSON.stringify(rows), headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
  });
}
const now = new Date().toISOString();
await rest("bank_syncs", { method: "POST", body: JSON.stringify({ source: "email", synced_at: now, summary: { scanned, found: rows.length } }), headers: { Prefer: "return=minimal" } });
console.log(`Email lette: ${scanned}, nuove proposte: ${rows.length}`);
