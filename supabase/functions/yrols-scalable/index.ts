// Edge Function "yrols-scalable": collega Scalable Capital tramite il suo server MCP ufficiale e ne legge i saldi.
//
// POST JSON con Authorization: Bearer <sessione Supabase dell'utente>:
//   { action: "start" }                         → { url }  (pagina di accesso Scalable, conferma nell'app Scalable)
//   { action: "complete", state, code?, error? } → { accounts, holdings } | { error }
//   { action: "sync", auto? }                   → { synced, accounts?, reason? }  (auto: solo se l'ultima lettura ha più di 30 minuti)
//   { action: "disconnect" }                    → { ok: true }  (cancella i token; conti e storico restano)
// Con Authorization: Bearer <chiave service_role> (GitHub Actions, ogni 6 ore): { action: "sync" }.
//
// Nessun secret dedicato: il client OAuth è pubblico (registrazione dinamica + PKCE), i token stanno in
// yrols.scalable_auth, leggibile solo da service_role. Scalable chiede un nuovo login al più tardi dopo 7 giorni.
// Secrets opzionali: SCALABLE_REDIRECT_URL, YROLS_ALLOWED_ORIGINS.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  authorizeUrl, BANK_NAME, buildSnapshot, CONNECTION_ID, exchangeCode, pkceChallenge, randomToken, readAll,
  refreshTokens, registerClient, ScalableError, ScalableMcp, type Tokens,
} from "../_shared/scalable.ts";

const env = (k: string) => Deno.env.get(k) ?? "";
const REDIRECT = env("SCALABLE_REDIRECT_URL") || "https://loriscuba.github.io/Yrols/callback/";
const ORIGINS = (env("YROLS_ALLOWED_ORIGINS") || "https://loriscuba.github.io,http://localhost:5173").split(",").map((s) => s.trim());
const PENDING_TTL_MS = 30 * 60 * 1000;
const AUTO_GAP_MS = 30 * 60 * 1000;
const MIN_GAP_MS = 60 * 1000;

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

const bearer = (req: Request) => /^Bearer\s+(\S+)/.exec(req.headers.get("Authorization") ?? "")?.[1] ?? null;

async function requireMember(req: Request): Promise<string> {
  const token = bearer(req);
  if (!token) throw new HttpError(401, "Accedi al cruscotto per collegare Scalable");
  const user = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY") || env("SUPABASE_SERVICE_ROLE_KEY"), {
    global: { headers: { Authorization: `Bearer ${token}` } },
    db: { schema: "yrols" },
    auth: { persistSession: false },
  });
  const { data: u, error: ue } = await user.auth.getUser();
  if (ue || !u.user) throw new HttpError(401, "Sessione scaduta: rientra nel cruscotto");
  const { data: member, error } = await user.rpc("yrols_is_member");
  if (error || member !== true) throw new HttpError(403, "Questo account non è abilitato al cruscotto");
  return u.user.id;
}

/** La chiave presentata è una chiave service_role valida? Lo verifica il database stesso. */
async function isServiceRole(req: Request): Promise<boolean> {
  const key = bearer(req);
  if (!key) return false;
  const probe = createClient(env("SUPABASE_URL"), key, { db: { schema: "yrols" }, auth: { persistSession: false } });
  const { error } = await probe.from("scalable_auth").select("id").limit(1);
  return !error;
}

// deno-lint-ignore no-explicit-any
function admin(): SupabaseClient<any, "yrols", "yrols"> {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { db: { schema: "yrols" }, auth: { persistSession: false } });
}

const must = <T>(r: { data: T; error: { message: string } | null }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

interface AuthRow {
  client_id: string; redirect_uri: string; refresh_token: string | null; access_token: string | null;
  access_expires_at: string | null; refreshing_until: string | null; status: string; logged_in_at: string | null; last_sync_at: string | null;
}

async function authRow(db: ReturnType<typeof admin>): Promise<AuthRow | null> {
  const rows = must(await db.from("scalable_auth").select("*").eq("id", "main").limit(1), "Lettura accesso Scalable") as AuthRow[];
  return rows?.[0] ?? null;
}

const expiresAt = (t: Tokens) => new Date(Date.now() + Math.max((t.expires_in ?? 1200) - 60, 60) * 1000).toISOString();

// ── Azioni ─────────────────────────────────────────────────────────────────

async function start(userId: string) {
  const db = admin();
  await db.from("scalable_auth_pending").delete().lt("created_at", new Date(Date.now() - PENDING_TTL_MS).toISOString());
  let row = await authRow(db);
  if (!row || row.redirect_uri !== REDIRECT) {
    const clientId = await registerClient(fetch, REDIRECT);
    must(await db.from("scalable_auth").upsert({
      id: "main", client_id: clientId, redirect_uri: REDIRECT, updated_at: new Date().toISOString(),
      ...(!row && { status: "pending" }),
    }), "Salvataggio client Scalable");
    row = (await authRow(db))!;
  }
  const state = `sc-${randomToken(16)}`;
  const verifier = randomToken(48);
  must(await db.from("scalable_auth_pending").insert({ state, code_verifier: verifier, created_by: userId }), "Salvataggio accesso");
  return { url: authorizeUrl({ clientId: row.client_id, redirectUri: row.redirect_uri, state, challenge: await pkceChallenge(verifier) }) };
}

async function complete(body: Record<string, unknown>) {
  const state = String(body.state ?? "");
  const db = admin();
  const rows = must(await db.from("scalable_auth_pending").select("*").eq("state", state).limit(1), "Lettura accesso") as
    { code_verifier: string; created_at: string }[];
  const pending = rows?.[0];
  if (!pending || Date.now() - Date.parse(pending.created_at) > PENDING_TTL_MS) {
    throw new HttpError(400, "Accesso scaduto o già completato: riparti da \"Collega Scalable\"");
  }
  await db.from("scalable_auth_pending").delete().eq("state", state);
  if (body.error) return { error: String(body.error) };
  const code = String(body.code ?? "");
  if (!code) throw new HttpError(400, "code mancante");

  const row = await authRow(db);
  if (!row) throw new HttpError(400, "Client Scalable non registrato: riparti da \"Collega Scalable\"");
  const t = await exchangeCode(fetch, { clientId: row.client_id, redirectUri: row.redirect_uri, code, verifier: pending.code_verifier });
  const now = new Date().toISOString();
  must(await db.from("scalable_auth").update({
    access_token: t.access_token, refresh_token: t.refresh_token ?? null, access_expires_at: expiresAt(t),
    refreshing_until: null, status: "active", logged_in_at: now, last_error: null, updated_at: now,
  }).eq("id", "main"), "Salvataggio token");
  must(await db.from("bank_connections").upsert({
    id: CONNECTION_ID, bank_name: BANK_NAME, country: "DE", valid_until: null, status: "active", updated_at: now,
  }), "Salvataggio connessione");
  // Collegato anche se la prima lettura non riesce: riprova "Aggiorna ora".
  try { return await syncNow(db, t.access_token); }
  catch (e) { return { synced: false, syncError: (e as Error).message }; }
}

/** Access token valido: riusa quello salvato o lo rinnova, con un lease per non usare due volte il refresh token. */
async function accessToken(db: ReturnType<typeof admin>): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const row = await authRow(db);
    if (!row || row.status !== "active") throw new ScalableError("Scalable non collegato", 401);
    if (row.access_token && row.access_expires_at && Date.parse(row.access_expires_at) > Date.now() + 60_000) return row.access_token;
    if (!row.refresh_token) throw new ScalableError("Accesso a Scalable da rinnovare", 401);
    const leaseUntil = new Date(Date.now() + 30_000).toISOString();
    const nowIso = new Date().toISOString();
    const { data: got } = await db.from("scalable_auth").update({ refreshing_until: leaseUntil })
      .eq("id", "main").or(`refreshing_until.is.null,refreshing_until.lt."${nowIso}"`).select("id");
    if (!got?.length) { await new Promise((r) => setTimeout(r, 1500)); continue; }
    try {
      const t = await refreshTokens(fetch, { clientId: row.client_id, refreshToken: row.refresh_token });
      must(await db.from("scalable_auth").update({
        access_token: t.access_token, refresh_token: t.refresh_token ?? row.refresh_token, access_expires_at: expiresAt(t),
        refreshing_until: null, updated_at: new Date().toISOString(),
      }).eq("id", "main"), "Salvataggio token");
      return t.access_token;
    } catch (e) {
      await db.from("scalable_auth").update({ refreshing_until: null }).eq("id", "main");
      throw e;
    }
  }
  throw new ScalableError("Rinnovo del token Scalable occupato: riprova tra poco");
}

async function syncNow(db: ReturnType<typeof admin>, token: string) {
  const data = await readAll(new ScalableMcp(token));
  const today = new Date().toISOString().slice(0, 10);
  const snap = buildSnapshot(data.portfolios, data.overnight, today);
  const now = new Date().toISOString();
  if (snap.accounts.length) {
    must(await db.from("bank_accounts").upsert(snap.accounts.map((a) => ({
      id: a.id, connection_id: CONNECTION_ID, bank_name: BANK_NAME, name: a.name, iban: null, currency: a.currency,
      source: "scalable", updated_at: now,
    }))), "Salvataggio conti");
    must(await db.from("bank_balances").upsert(snap.balances.map((b) => ({
      account_id: b.accountId, type: b.type, date: b.date, amount: b.amount, currency: "EUR",
    }))), "Salvataggio saldi");
    const titoli = [...new Set(snap.accounts.filter((a) => a.id.endsWith("-titoli")).map((a) => a.id))];
    if (titoli.length) {
      // Le posizioni chiuse spariscono: si riscrive l'elenco del portafoglio.
      must(await db.from("investment_holdings").delete().in("account_id", titoli), "Pulizia posizioni");
      if (snap.holdings.length) {
        must(await db.from("investment_holdings").insert(snap.holdings.map((h) => ({
          account_id: h.accountId, isin: h.isin, name: h.name, quantity: h.quantity, price: h.price, currency: h.currency,
          value: h.value, updated_at: now,
        }))), "Salvataggio posizioni");
      }
    }
  }
  must(await db.from("scalable_auth").update({ last_sync_at: now, last_error: null, updated_at: now }).eq("id", "main"), "Stato");
  return { synced: true, accounts: snap.accounts.length, holdings: snap.holdings.length };
}

async function sync(body: Record<string, unknown>) {
  const db = admin();
  const row = await authRow(db);
  if (!row || row.status === "pending") return { synced: false, reason: "not_connected" };
  if (row.status === "expired") return { synced: false, reason: "expired" };
  const gap = body.auto === true ? AUTO_GAP_MS : MIN_GAP_MS;
  if (row.last_sync_at && Date.now() - Date.parse(row.last_sync_at) < gap) return { synced: false, reason: "recent" };
  try {
    return await syncNow(db, await accessToken(db));
  } catch (e) {
    const err = e instanceof ScalableError ? e : null;
    const now = new Date().toISOString();
    if (err?.needsLogin) {
      await db.from("scalable_auth").update({ status: "expired", access_token: null, last_error: "Accesso scaduto: rinnova", updated_at: now }).eq("id", "main");
      return { synced: false, reason: "expired" };
    }
    await db.from("scalable_auth").update({ last_error: (e as Error).message.slice(0, 300), updated_at: now }).eq("id", "main");
    throw e;
  }
}

async function disconnect() {
  const db = admin();
  must(await db.from("scalable_auth").update({
    status: "pending", access_token: null, refresh_token: null, access_expires_at: null, logged_in_at: null, last_error: null,
    updated_at: new Date().toISOString(),
  }).eq("id", "main"), "Scollegamento");
  must(await db.from("bank_connections").update({ status: "revoked", updated_at: new Date().toISOString() }).eq("id", CONNECTION_ID), "Revoca");
  return { ok: true };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return json(req, 405, { error: "Usa POST" });
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.action === "sync" && await isServiceRole(req)) return json(req, 200, await sync(body));
    const userId = await requireMember(req);
    switch (body.action) {
      case "start": return json(req, 200, await start(userId));
      case "complete": return json(req, 200, await complete(body));
      case "sync": return json(req, 200, await sync(body));
      case "disconnect": return json(req, 200, await disconnect());
      default: throw new HttpError(400, "action non valida");
    }
  } catch (e) {
    if (e instanceof HttpError) return json(req, e.status, { error: e.message });
    if (e instanceof ScalableError) {
      console.error(`scalable: ${e.message}`);
      return json(req, 502, { error: e.message, upstreamStatus: e.status });
    }
    console.error((e as Error).message);
    return json(req, 500, { error: (e as Error).message });
  }
});
