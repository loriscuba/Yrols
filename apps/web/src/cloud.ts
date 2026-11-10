/**
 * Modalità online: il cruscotto parla direttamente con Supabase invece che con il server locale.
 * Traduce le stesse richieste "/api/..." usate dalle pagine in query Supabase, così le pagine non cambiano.
 * La sicurezza è nel database (RLS): la chiave "anon" pubblicata nella pagina non dà accesso ai dati.
 */
import { createClient } from "@supabase/supabase-js";

const URL_ = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
export const cloudEnabled = !!(URL_ && KEY);
export const supabase = cloudEnabled ? createClient(URL_!, KEY!, { db: { schema: "yrols" } }) : null;

const META = {
  billKinds: ["luce", "gas", "acqua", "internet", "telefono", "rifiuti", "condominio", "affitto", "mutuo", "altro"],
  deadlineCategories: ["casa", "auto", "tasse", "assicurazione", "salute", "documenti", "abbonamenti", "scuola", "altro"],
  recurrences: ["none", "monthly", "bimonthly", "quarterly", "semiannual", "yearly"],
  priorities: ["bassa", "normale", "alta"],
};

type Def = { cols: Record<string, string>; numeric: string[]; order: [string, boolean, boolean?][] };
const TABLES: Record<string, Def> = {
  bills: {
    cols: { provider: "provider", kind: "kind", amount: "amount", dueDate: "due_date", periodFrom: "period_from", periodTo: "period_to", paidAt: "paid_at", notes: "notes" },
    numeric: ["amount"],
    order: [["paid_at", true, false], ["due_date", true]],
  },
  deadlines: {
    cols: { title: "title", category: "category", dueDate: "due_date", amount: "amount", recurrence: "recurrence", doneAt: "done_at", notes: "notes" },
    numeric: ["amount"],
    order: [["done_at", true, false], ["due_date", true]],
  },
  reminders: {
    cols: { text: "text", remindAt: "remind_at", priority: "priority", doneAt: "done_at" },
    numeric: [],
    order: [["done_at", true, false], ["remind_at", true, true], ["id", false]],
  },
};
const select = (d: Def) => ["id", ...Object.entries(d.cols).map(([k, c]) => (k === c ? c : `${k}:${c}`)), "createdAt:created_at"].join(",");

function toRow(d: Def, body: Record<string, unknown>) {
  const row: Record<string, unknown> = {};
  for (const [k, c] of Object.entries(d.cols)) {
    if (!(k in body)) continue;
    let v = body[k];
    if (v === "" || v === undefined) v = null;
    if (v !== null && d.numeric.includes(k)) {
      const n = typeof v === "string" ? Number(v.includes(",") ? v.replace(/\./g, "").replace(",", ".") : v) : v;
      if (typeof n !== "number" || !Number.isFinite(n)) throw new Error(`${k === "amount" ? "Importo" : k} non valido`);
      v = n;
    }
    row[c] = v;
  }
  return row;
}

/** Messaggi di errore leggibili per i vincoli del database. */
function friendly(e: { message?: string; code?: string } | null): Error {
  const m = e?.message ?? "Errore sconosciuto";
  if (e?.code === "23502") return new Error("Compila tutti i campi obbligatori");
  if (e?.code === "23514") return new Error("Valore non valido in uno dei campi");
  if (e?.code === "42501" || /permission|row-level/i.test(m)) return new Error("Accesso non autorizzato: rientra con il tuo account");
  return new Error(m);
}
function ok<T>(r: { data: T; error: { message: string; code?: string } | null }): T {
  if (r.error) throw friendly(r.error);
  return r.data;
}
const num = <T extends Record<string, unknown>>(rows: T[], keys: string[]) =>
  rows.map((r) => { const o: Record<string, unknown> = { ...r }; for (const k of keys) if (o[k] !== null && o[k] !== undefined) o[k] = Number(o[k]); return o as T; });

export async function cloudRequest<T>(method: string, fullPath: string, body?: unknown): Promise<T> {
  const sb = supabase!;
  const [path, qs] = fullPath.split("?");
  const q = new URLSearchParams(qs ?? "");
  const parts = path.split("/").filter(Boolean);
  const b = (body ?? {}) as Record<string, unknown>;

  if (path === "/overview") return ok(await sb.rpc("yrols_overview")) as T;
  if (path === "/meta") return META as T;

  const def = TABLES[parts[0]];
  if (def) {
    const sel = select(def);
    const id = parts[1] ? Number(parts[1]) : null;
    if (method === "GET") {
      let query = sb.from(parts[0]).select(sel);
      for (const [col, asc, nullsFirst] of def.order) query = query.order(col, { ascending: asc, nullsFirst });
      return num(ok(await query) as unknown as Record<string, unknown>[], def.numeric) as T;
    }
    if (method === "POST") return ok(await sb.from(parts[0]).insert(toRow(def, b)).select(sel).single()) as T;
    if (method === "PATCH") return ok(await sb.from(parts[0]).update(toRow(def, b)).eq("id", id).select(sel).single()) as T;
    if (method === "DELETE") { ok(await sb.from(parts[0]).delete().eq("id", id)); return undefined as T; }
  }

  if (parts[0] === "banks") {
    if (parts[1] === "accounts") return ok(await sb.from("yrols_accounts").select("*").order("bankName").order("name")) as T;
    if (parts[1] === "connections")
      return ok(await sb.from("bank_connections").select("id,bankName:bank_name,country,validUntil:valid_until,status").order("valid_until")) as T;
    if (parts[1] === "history") return ok(await sb.rpc("yrols_history", { days: Number(q.get("days")) || 180 })) as T;
    if (parts[1] === "last-sync") {
      const r = ok(await sb.from("bank_syncs").select("source,syncedAt:synced_at,receivedAt:received_at,summary")
        .neq("source", "email").order("id", { ascending: false }).limit(1));
      return (r?.[0] ?? null) as T;
    }
    if (parts[1] === "transactions") {
      let query = sb.from("yrols_transactions").select("*");
      if (q.get("accountId")) query = query.eq("accountId", q.get("accountId")!);
      if (q.get("from")) query = query.gte("bookingDate", q.get("from")!);
      if (q.get("to")) query = query.lte("bookingDate", q.get("to")!);
      const text = q.get("q")?.replace(/[,()*%]/g, " ").trim();
      if (text) query = query.or(`description.ilike.*${text}*,counterparty.ilike.*${text}*`);
      return ok(await query.order("bookingDate", { ascending: false }).limit(Math.min(Number(q.get("limit")) || 200, 2000))) as T;
    }
  }

  if (parts[0] === "email") {
    if (parts[1] === "status") {
      const r = ok(await sb.rpc("yrols_email_status")) as { account: { email: string; status: string; provider: string } | null; lastScan: unknown } | null;
      const acc = r?.account ?? null;
      return { configured: !!acc || !!r?.lastScan, cloud: true, user: acc?.email ?? null, host: null, provider: acc?.provider ?? null,
        accountStatus: acc?.status ?? null, lastScan: r?.lastScan ?? null } as T;
    }
    if (parts[1] === "scan") throw new Error("Online la posta viene letta in automatico ogni ora da GitHub");
    if (parts[1] === "suggestions" && !parts[2]) {
      const r = ok(await sb.from("email_suggestions")
        .select("id,sender,subject,receivedAt:received_at,kind,provider,billKind:bill_kind,title,amount,dueDate:due_date,snippet,status,createdId:created_id")
        .eq("status", q.get("status") ?? "pending").order("due_date", { ascending: false, nullsFirst: false }));
      return num(r as Record<string, unknown>[], ["amount"]) as T;
    }
    if (parts[3] === "accept") return ok(await sb.rpc("yrols_accept_suggestion", { suggestion_id: Number(parts[2]), overrides: b })) as T;
    if (parts[3] === "dismiss") { ok(await sb.from("email_suggestions").update({ status: "dismissed" }).eq("id", Number(parts[2]))); return undefined as T; }
  }

  throw new Error(`Richiesta non supportata online: ${method} ${path}`);
}
