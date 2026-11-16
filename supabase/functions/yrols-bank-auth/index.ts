// Edge Function "yrols-bank-auth": collega e rinnova le banche dall'app Yrols.
//
// POST JSON con Authorization: Bearer <sessione Supabase dell'utente>:
//   { action: "banks", country }                          → { banks: [{ name, country, logo, maxConsentDays }] }
//   { action: "start", bankName, country, consentDays?, replaces? } → { url }
//   { action: "complete", state, code? , error? }          → { bankName, country, accounts, validUntil, synced } | { bankName, country, error }
//   { action: "disconnect", id }                          → { ok: true }
//   { action: "refresh", auto? }                          → { refreshed, lastSync, newTransactions?, errors? } | { refreshed: false, reason, retryInSeconds }
//     Legge saldi e movimenti con l'utente presente (intestazioni Psu-*: fuori dal limite PSD2 di 4 letture al giorno).
//     auto=true (apertura dell'app): solo se l'ultimo aggiornamento ha più di 30 minuti; dal pulsante almeno 2 minuti.
//
// Secrets della funzione: EB_APP_ID, EB_PRIVATE_KEY (contenuto del .pem),
// opzionali EB_REDIRECT_URL, EB_BASE_URL, YROLS_ALLOWED_ORIGINS.
// SUPABASE_URL, SUPABASE_ANON_KEY e SUPABASE_SERVICE_ROLE_KEY sono forniti da Supabase.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  accountName, EbError, EnableBanking, normalizeBalance, normalizeTransaction, psuHeaders, refreshWait, type EbAccount,
} from "../_shared/enablebanking.ts";

const env = (k: string) => Deno.env.get(k) ?? "";
const REDIRECT = env("EB_REDIRECT_URL") || "https://loriscuba.github.io/Yrols/callback/";
const ORIGINS = (env("YROLS_ALLOWED_ORIGINS") || "https://loriscuba.github.io,http://localhost:5173").split(",").map((s) => s.trim());
const PENDING_TTL_MS = 60 * 60 * 1000;
const HISTORY_DAYS = 90;
const REFRESH_DAYS = 14;

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(origin) ? origin : ORIGINS[0]!,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

const json = (req: Request, status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });

async function requireMember(req: Request): Promise<string> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!/^Bearer\s+\S+/.test(auth)) throw new HttpError(401, "Accedi al cruscotto per collegare una banca");
  const user = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY") || env("SUPABASE_SERVICE_ROLE_KEY"), {
    global: { headers: { Authorization: auth } },
    db: { schema: "yrols" },
    auth: { persistSession: false },
  });
  const { data: u, error: ue } = await user.auth.getUser();
  if (ue || !u.user) throw new HttpError(401, "Sessione scaduta: rientra nel cruscotto");
  const { data: member, error } = await user.rpc("yrols_is_member");
  if (error || member !== true) throw new HttpError(403, "Questo account non è abilitato al cruscotto");
  return u.user.id;
}

// deno-lint-ignore no-explicit-any
function admin(): SupabaseClient<any, "yrols", "yrols"> {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    db: { schema: "yrols" },
    auth: { persistSession: false },
  });
}

function eb(): EnableBanking {
  const appId = env("EB_APP_ID"), pem = env("EB_PRIVATE_KEY");
  if (!appId || !pem) throw new HttpError(503, "Chiave Enable Banking non configurata nei secret della funzione (EB_APP_ID, EB_PRIVATE_KEY)");
  return new EnableBanking(appId, pem, env("EB_BASE_URL") || undefined);
}

const must = <T>(r: { data: T; error: { message: string } | null }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

// ── Azioni ─────────────────────────────────────────────────────────────────

async function banks(body: Record<string, unknown>) {
  const country = String(body.country ?? "IT").toUpperCase();
  const list = await eb().aspsps(country);
  return {
    banks: list
      .map((a) => ({ name: a.name, country: a.country, logo: a.logo, maxConsentDays: a.maximum_consent_validity ? Math.floor(a.maximum_consent_validity / 86400) : undefined }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

async function start(body: Record<string, unknown>, userId: string) {
  const bankName = String(body.bankName ?? "").trim();
  const country = String(body.country ?? "IT").toUpperCase();
  if (!bankName) throw new HttpError(400, "bankName obbligatorio");
  const days = Math.min(Math.max(Math.round(Number(body.consentDays) || 90), 1), 180);
  const db = admin();
  await db.from("bank_auth_pending").delete().lt("created_at", new Date(Date.now() - PENDING_TTL_MS).toISOString());
  const state = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const validUntil = new Date(Date.now() + days * 86_400_000).toISOString();
  const { url } = await eb().startAuth(bankName, country, validUntil, state, REDIRECT);
  must(await db.from("bank_auth_pending").insert({
    state, bank_name: bankName, country, consent_days: days,
    replaces: typeof body.replaces === "string" ? body.replaces : null, created_by: userId,
  }), "Salvataggio consenso");
  return { url };
}

interface ExistingAccount { id: string; bank_name: string | null; iban: string | null; currency: string | null; name: string | null; identification_hash: string | null }

/** Riusa l'id storico del conto (stesso hash, oppure stessa banca+IBAN+valuta, oppure stessa banca+nome senza IBAN). */
function matchAccount(raw: EbAccount, bankName: string, existing: ExistingAccount[]): string | undefined {
  const iban = raw.account_id?.iban ?? null;
  const cur = raw.currency ?? "EUR";
  const sameBank = existing.filter((e) => (e.bank_name ?? "").toLowerCase() === bankName.toLowerCase());
  if (raw.identification_hash) {
    const h = sameBank.find((e) => e.identification_hash === raw.identification_hash);
    if (h) return h.id;
  }
  if (iban) return sameBank.find((e) => e.iban === iban && (e.currency ?? "EUR") === cur)?.id;
  const name = accountName(raw);
  return sameBank.find((e) => !e.iban && e.name === name && (e.currency ?? "EUR") === cur)?.id;
}

async function complete(body: Record<string, unknown>) {
  const state = String(body.state ?? "");
  const db = admin();
  const rows = must(await db.from("bank_auth_pending").select("*").eq("state", state).limit(1), "Lettura consenso");
  const pending = rows?.[0] as { bank_name: string; country: string; consent_days: number; replaces: string | null; created_at: string } | undefined;
  if (!pending || Date.now() - Date.parse(pending.created_at) > PENDING_TTL_MS) {
    throw new HttpError(400, "Collegamento scaduto o già completato: riparti da \"Collega banca\"");
  }
  await db.from("bank_auth_pending").delete().eq("state", state);

  if (body.error) return { bankName: pending.bank_name, country: pending.country, consentDays: pending.consent_days, error: String(body.error) };
  const code = String(body.code ?? "");
  if (!code) throw new HttpError(400, "code mancante");

  const client = eb();
  const session = await client.createSession(code);
  const bankName = session.aspsp?.name ?? pending.bank_name;
  const country = session.aspsp?.country ?? pending.country;
  const validUntil = session.access?.valid_until ?? null;
  if (!session.accounts?.length) {
    try { await client.deleteSession(session.session_id); } catch { /* già chiusa */ }
    return { bankName, country, error: "no_accounts" };
  }

  // Connessioni precedenti della stessa banca: sostituite da questa.
  const old = must(await db.from("bank_connections").select("id").eq("bank_name", bankName).eq("country", country).neq("status", "revoked"), "Lettura connessioni") as { id: string }[];
  const replaced = new Set([...old.map((o) => o.id), ...(pending.replaces ? [pending.replaces] : [])]);
  replaced.delete(session.session_id);

  must(await db.from("bank_connections").upsert({
    id: session.session_id, bank_name: bankName, country, valid_until: validUntil, status: "active", updated_at: new Date().toISOString(),
  }), "Salvataggio connessione");

  const existing = must(await db.from("bank_accounts").select("id,bank_name,iban,currency,name,identification_hash"), "Lettura conti") as ExistingAccount[];
  const accounts = session.accounts.map((raw) => ({
    id: matchAccount(raw, bankName, existing) ?? raw.uid,
    eb_uid: raw.uid,
    connection_id: session.session_id,
    bank_name: bankName,
    name: accountName(raw) ?? null,
    iban: raw.account_id?.iban ?? null,
    currency: raw.currency ?? "EUR",
    identification_hash: raw.identification_hash ?? null,
    source: "enablebanking",
    updated_at: new Date().toISOString(),
  }));
  must(await db.from("bank_accounts").upsert(accounts), "Salvataggio conti");

  if (replaced.size) {
    must(await db.from("bank_connections").update({ status: "revoked", updated_at: new Date().toISOString() }).in("id", [...replaced]), "Chiusura vecchie connessioni");
    for (const id of replaced) { try { await client.deleteSession(id); } catch { /* già scaduta */ } }
  }

  // Prima sincronizzazione subito, così il cruscotto si aggiorna senza aspettare GitHub.
  const dateFrom = new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString().slice(0, 10);
  const balances = [], transactions = [], errors: string[] = [];
  for (const a of accounts) {
    try { balances.push(...((await client.balances(a.eb_uid)).balances ?? []).map((b) => normalizeBalance(b, a.id))); }
    catch (e) { errors.push((e as Error).message); }
    try { for (const t of await client.transactions(a.eb_uid, dateFrom)) transactions.push(await normalizeTransaction(t, a.id)); }
    catch (e) { errors.push((e as Error).message); }
  }
  const synced = must(await db.rpc("yrols_bank_sync", {
    payload: { source: "enablebanking", syncedAt: new Date().toISOString(), balances, transactions },
  }), "Sincronizzazione");

  return {
    bankName, country, validUntil,
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, iban: a.iban ? `…${a.iban.slice(-4)}` : null, currency: a.currency })),
    synced, errors,
  };
}

async function disconnect(body: Record<string, unknown>) {
  const id = String(body.id ?? "");
  if (!id) throw new HttpError(400, "id obbligatorio");
  try { await eb().deleteSession(id); } catch (e) { if (!(e instanceof EbError) || ![404, 410, 422].includes(e.status)) throw e; }
  must(await admin().from("bank_connections").update({ status: "revoked", updated_at: new Date().toISOString() }).eq("id", id), "Revoca");
  return { ok: true };
}

async function lastBankSync(db: ReturnType<typeof admin>): Promise<string | null> {
  const rows = must(await db.from("bank_syncs").select("received_at").neq("source", "email").order("id", { ascending: false }).limit(1), "Lettura ultimo aggiornamento") as { received_at: string }[];
  return rows?.[0]?.received_at ?? null;
}

async function countTransactions(db: ReturnType<typeof admin>): Promise<number | null> {
  const { count, error } = await db.from("bank_transactions").select("id", { count: "exact", head: true });
  return error ? null : count ?? null;
}

async function refresh(body: Record<string, unknown>, req: Request) {
  const auto = body.auto === true;
  const db = admin();
  const last = await lastBankSync(db);
  const wait = refreshWait(last, auto);
  if (wait !== null) return { refreshed: false, reason: "recent", lastSync: last, retryInSeconds: Math.ceil(wait / 1000) };

  const psu = psuHeaders(req);
  if (!psu) throw new HttpError(400, "Non riesco a leggere l'indirizzo del dispositivo: riprova più tardi");

  const now = new Date().toISOString();
  const conns = must(await db.from("bank_connections").select("id,bank_name,valid_until").neq("status", "revoked"), "Lettura connessioni") as
    { id: string; bank_name: string | null; valid_until: string | null }[];
  const live = new Map(conns.filter((c) => !c.valid_until || c.valid_until > now).map((c) => [c.id, c]));
  const accounts = (must(await db.from("bank_accounts").select("id,eb_uid,connection_id,bank_name").eq("source", "enablebanking"), "Lettura conti") as
    { id: string; eb_uid: string | null; connection_id: string | null; bank_name: string | null }[])
    .filter((a) => a.eb_uid && a.connection_id && live.has(a.connection_id));
  if (!accounts.length) return { refreshed: false, reason: "no_accounts", lastSync: last };

  const client = eb();
  const dateFrom = new Date(Date.now() - REFRESH_DAYS * 86_400_000).toISOString().slice(0, 10);
  const balances: ReturnType<typeof normalizeBalance>[] = [];
  const transactions: Awaited<ReturnType<typeof normalizeTransaction>>[] = [];
  const errors: { bank: string; message: string }[] = [];
  let okAccounts = 0;
  // Conti in parallelo per banca, così l'attesa è quella della banca più lenta.
  await Promise.all(accounts.map(async (a) => {
    const bank = a.bank_name ?? "Banca";
    try {
      balances.push(...((await client.balances(a.eb_uid!, psu)).balances ?? []).map((b) => normalizeBalance(b, a.id)));
      for (const t of await client.transactions(a.eb_uid!, dateFrom, psu)) transactions.push(await normalizeTransaction(t, a.id));
      okAccounts++;
    } catch (e) {
      const status = e instanceof EbError ? e.status : 0;
      const message = status === 429 ? "la banca chiede di riprovare più tardi"
        : status === 401 || status === 403 || status === 422 ? "consenso da rinnovare dalla pagina Banche"
        : "lettura non riuscita";
      console.error(`refresh ${bank}: ${(e as Error).message}`);
      if (!errors.some((x) => x.bank === bank)) errors.push({ bank, message });
    }
  }));
  if (!okAccounts) return { refreshed: false, reason: "bank_error", lastSync: last, errors };

  const before = await countTransactions(db);
  // Il trigger su bank_transactions ricollega anche gli scontrini ai movimenti nuovi.
  const synced = must(await db.rpc("yrols_bank_sync", {
    payload: { source: "app", syncedAt: new Date().toISOString(), balances, transactions },
  }), "Sincronizzazione");
  const after = await countTransactions(db);
  return {
    refreshed: true, lastSync: new Date().toISOString(), synced, errors,
    newTransactions: before !== null && after !== null ? Math.max(after - before, 0) : undefined,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return json(req, 405, { error: "Usa POST" });
  try {
    const userId = await requireMember(req);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    switch (body.action) {
      case "banks": return json(req, 200, await banks(body));
      case "start": return json(req, 200, await start(body, userId));
      case "complete": return json(req, 200, await complete(body));
      case "disconnect": return json(req, 200, await disconnect(body));
      case "refresh": return json(req, 200, await refresh(body, req));
      default: throw new HttpError(400, "action non valida");
    }
  } catch (e) {
    if (e instanceof HttpError) return json(req, e.status, { error: e.message });
    if (e instanceof EbError) return json(req, 502, { error: e.message, upstreamStatus: e.status });
    console.error(e);
    return json(req, 500, { error: (e as Error).message });
  }
});
