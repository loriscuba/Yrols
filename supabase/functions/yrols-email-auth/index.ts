// Edge Function "yrols-email-auth": collega Gmail al cruscotto con Google OAuth in sola lettura.
//
// POST JSON con Authorization: Bearer <sessione Supabase dell'utente>:
//   { action: "start", loginHint? }          → { url }  (pagina di consenso Google)
//   { action: "complete", state, code?, error? } → { email } | { error }
//   { action: "disconnect" }                 → { ok: true }  (revoca su Google e cancella il token)
// POST JSON con Authorization: Bearer <chiave service_role> (lettura su GitHub Actions):
//   { action: "token" }                      → { accessToken, email } | 404 se nessuna Gmail collegata
//
// Secrets della funzione: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
// opzionali GOOGLE_REDIRECT_URL, YROLS_ALLOWED_ORIGINS.
// Il client secret resta solo qui: il refresh token salvato nel database da solo non serve a nulla.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { authUrl, exchangeCode, GoogleError, gmailAddress, hasGmailScope, refreshAccessToken, revoke, type GoogleClient } from "../_shared/google.ts";

const env = (k: string) => Deno.env.get(k) ?? "";
const REDIRECT = env("GOOGLE_REDIRECT_URL") || "https://loriscuba.github.io/Yrols/callback/";
const ORIGINS = (env("YROLS_ALLOWED_ORIGINS") || "https://loriscuba.github.io,http://localhost:5173").split(",").map((s) => s.trim());
const PENDING_TTL_MS = 30 * 60 * 1000;

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

const bearer = (req: Request) => (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();

async function requireMember(req: Request): Promise<string> {
  const token = bearer(req);
  if (!token) throw new HttpError(401, "Accedi al cruscotto per collegare la posta");
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
async function requireServiceRole(req: Request) {
  const key = bearer(req);
  if (!key) throw new HttpError(401, "Chiave mancante");
  const probe = createClient(env("SUPABASE_URL"), key, { db: { schema: "yrols" }, auth: { persistSession: false } });
  const { error } = await probe.from("email_accounts").select("id").limit(1);
  if (error) throw new HttpError(403, "Chiave non autorizzata");
}

// deno-lint-ignore no-explicit-any
function admin(): SupabaseClient<any, "yrols", "yrols"> {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { db: { schema: "yrols" }, auth: { persistSession: false } });
}

function google(): GoogleClient {
  const clientId = env("GOOGLE_CLIENT_ID"), clientSecret = env("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new HttpError(503, "Credenziali Google non configurate nei secret della funzione (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)");
  return { clientId, clientSecret, redirectUri: REDIRECT };
}

const must = <T>(r: { data: T; error: { message: string } | null }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

interface Account { id: string; email: string; refresh_token: string; status: string }
async function currentAccount(): Promise<Account | undefined> {
  const rows = must(await admin().from("email_accounts").select("id,email,refresh_token,status").order("connected_at", { ascending: false }).limit(1), "Lettura casella");
  return (rows as Account[] | null)?.[0];
}

// ── Azioni ─────────────────────────────────────────────────────────────────

async function start(body: Record<string, unknown>, userId: string) {
  const g = google();
  const db = admin();
  await db.from("email_auth_pending").delete().lt("created_at", new Date(Date.now() - PENDING_TTL_MS).toISOString());
  // Il prefisso "gm-" permette alla pagina /callback/ di distinguere Google dalle banche.
  const state = "gm-" + [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  must(await db.from("email_auth_pending").insert({ state, created_by: userId }), "Salvataggio collegamento");
  return { url: authUrl(g, state, typeof body.loginHint === "string" ? body.loginHint : undefined) };
}

async function complete(body: Record<string, unknown>) {
  const state = String(body.state ?? "");
  const db = admin();
  const rows = must(await db.from("email_auth_pending").select("*").eq("state", state).limit(1), "Lettura collegamento");
  const pending = (rows as { created_at: string }[] | null)?.[0];
  if (!pending || Date.now() - Date.parse(pending.created_at) > PENDING_TTL_MS) {
    throw new HttpError(400, "Collegamento scaduto o già completato: riparti da \"Collega Gmail\"");
  }
  await db.from("email_auth_pending").delete().eq("state", state);
  if (body.error) return { error: String(body.error) };
  const code = String(body.code ?? "");
  if (!code) throw new HttpError(400, "code mancante");

  const g = google();
  const tok = await exchangeCode(g, code);
  if (!hasGmailScope(tok.scope)) {
    await revoke(tok.access_token).catch(() => {});
    return { error: "scope_missing" };
  }
  if (!tok.refresh_token) return { error: "no_refresh_token" };
  const email = await gmailAddress(tok.access_token);

  // Una sola casella: la nuova sostituisce la precedente (il cui permesso viene revocato).
  const old = await currentAccount();
  must(await db.from("email_accounts").upsert({
    id: "gmail", provider: "gmail", email, refresh_token: tok.refresh_token, scope: tok.scope ?? null,
    status: "active", last_error: null, connected_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }), "Salvataggio casella");
  if (old && old.refresh_token !== tok.refresh_token) await revoke(old.refresh_token).catch(() => {});
  return { email };
}

async function disconnect() {
  const acc = await currentAccount();
  if (acc) {
    await revoke(acc.refresh_token).catch(() => {});
    must(await admin().from("email_accounts").delete().eq("id", acc.id), "Cancellazione casella");
  }
  return { ok: true };
}

/** Access token di un'ora per la lettura su GitHub Actions. */
async function token(req: Request) {
  await requireServiceRole(req);
  const acc = await currentAccount();
  if (!acc) throw new HttpError(404, "Nessuna Gmail collegata");
  try {
    const t = await refreshAccessToken(google(), acc.refresh_token);
    if (acc.status !== "active") await admin().from("email_accounts").update({ status: "active", last_error: null }).eq("id", acc.id);
    return { accessToken: t.access_token, email: acc.email, expiresIn: t.expires_in };
  } catch (e) {
    if (e instanceof GoogleError && e.code === "invalid_grant") {
      // Permesso revocato o scaduto: il cruscotto mostrerà "Ricollega Gmail".
      await admin().from("email_accounts").update({ status: "expired", last_error: "Accesso revocato o scaduto", updated_at: new Date().toISOString() }).eq("id", acc.id);
      throw new HttpError(409, "Accesso Gmail scaduto: ricollega la casella dal cruscotto");
    }
    throw e;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return json(req, 405, { error: "Usa POST" });
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.action === "token") return json(req, 200, await token(req));
    const userId = await requireMember(req);
    switch (body.action) {
      case "start": return json(req, 200, await start(body, userId));
      case "complete": return json(req, 200, await complete(body));
      case "disconnect": return json(req, 200, await disconnect());
      default: throw new HttpError(400, "action non valida");
    }
  } catch (e) {
    if (e instanceof HttpError) return json(req, e.status, { error: e.message });
    if (e instanceof GoogleError) return json(req, 502, { error: e.message, upstreamStatus: e.status });
    console.error((e as Error).message);
    return json(req, 500, { error: (e as Error).message });
  }
});
