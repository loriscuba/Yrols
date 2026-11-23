// Edge Function "yrols-push": notifiche push sul cellulare e sul computer (Web Push, standard dei browser).
//
// POST JSON:
//   { action: "key" }   → { publicKey }  chiave VAPID pubblica per iscriversi (la crea la prima volta)
//   { action: "send" }  → { sent, ... }  spedisce le novità ancora da inviare. Lo chiama il database (trigger con pg_net)
//                          con l'intestazione x-yrols-hook, il cui gettone sta in yrols.push_config.
//   { action: "test" }  → { sent }       notifica di prova, solo per il proprietario (Authorization: Bearer <sessione>)
//
// Nessun secret dedicato: chiavi VAPID e gettone stanno in yrols.push_config, leggibile solo da service_role.
// Pubblicare con verify_jwt false (la chiama il database). Secret opzionale: YROLS_ALLOWED_ORIGINS.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { generateVapidKeys, sendPush, summarize, type Notice, type PushMessage, type VapidKeys } from "../_shared/webpush.ts";

const env = (k: string) => Deno.env.get(k) ?? "";
const ORIGINS = (env("YROLS_ALLOWED_ORIGINS") || "https://loriscuba.github.io,http://localhost:5173").split(",").map((s) => s.trim());
const SUBJECT = "https://loriscuba.github.io/Yrols/";
const MAX_FAILURES = 10;

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

// deno-lint-ignore no-explicit-any
type Db = SupabaseClient<any, "yrols", "yrols">;
const admin = (): Db =>
  createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { db: { schema: "yrols" }, auth: { persistSession: false } });

const must = <T>(r: { data: T; error: { message: string } | null }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

type Config = { vapid_public: string | null; vapid_private: JsonWebKey | null; hook_token: string };

async function config(db: Db): Promise<Config & { keys: VapidKeys }> {
  let c = must(await db.from("push_config").select("vapid_public,vapid_private,hook_token").eq("id", 1).single(), "Configurazione") as Config;
  if (!c.vapid_public || !c.vapid_private) {
    const k = await generateVapidKeys();
    // Solo la prima chiamata scrive le chiavi; le altre rileggono quelle salvate.
    await db.from("push_config").update({ vapid_public: k.publicKey, vapid_private: k.privateJwk }).eq("id", 1).is("vapid_public", null);
    c = must(await db.from("push_config").select("vapid_public,vapid_private,hook_token").eq("id", 1).single(), "Configurazione") as Config;
  }
  return { ...c, keys: { publicKey: c.vapid_public!, privateJwk: c.vapid_private! } };
}

async function requireMember(req: Request) {
  const token = /^Bearer\s+(\S+)/.exec(req.headers.get("Authorization") ?? "")?.[1];
  if (!token) throw new HttpError(401, "Accedi al cruscotto");
  const user = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY") || env("SUPABASE_SERVICE_ROLE_KEY"), {
    global: { headers: { Authorization: `Bearer ${token}` } }, db: { schema: "yrols" }, auth: { persistSession: false },
  });
  const { data: u, error: ue } = await user.auth.getUser();
  if (ue || !u.user) throw new HttpError(401, "Sessione scaduta: rientra nel cruscotto");
  const { data: member, error } = await user.rpc("yrols_is_member");
  if (error || member !== true) throw new HttpError(403, "Questo account non è abilitato al cruscotto");
}

type Sub = { endpoint: string; p256dh: string; auth: string; kinds: string[]; failures: number };

/** Spedisce a ogni dispositivo le novità dei tipi che ha scelto; toglie le iscrizioni scadute. */
async function deliver(db: Db, keys: VapidKeys, forSub: (s: Sub) => PushMessage | null) {
  const subs = must(await db.from("push_subscriptions").select("endpoint,p256dh,auth,kinds,failures"), "Dispositivi") as Sub[];
  let sent = 0, removed = 0, failed = 0;
  for (const s of subs) {
    const msg = forSub(s);
    if (!msg) continue;
    let status = 0;
    try { status = await sendPush(s, msg, keys, SUBJECT); } catch { status = 0; }
    if (status >= 200 && status < 300) {
      sent++;
      await db.from("push_subscriptions").update({ last_ok_at: new Date().toISOString(), failures: 0 }).eq("endpoint", s.endpoint);
    } else if (status === 404 || status === 410 || s.failures + 1 >= MAX_FAILURES) {
      removed++;
      await db.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
    } else {
      failed++;
      await db.from("push_subscriptions").update({ failures: s.failures + 1 }).eq("endpoint", s.endpoint);
    }
  }
  return { devices: subs.length, sent, removed, failed };
}

async function send(req: Request) {
  const db = admin();
  const c = await config(db);
  if (req.headers.get("x-yrols-hook") !== c.hook_token) throw new HttpError(403, "Non autorizzato");
  const items = must(await db.rpc("yrols_push_claim"), "Novità") as (Notice & { id: number })[];
  if (!items.length) return { notices: 0 };
  items.sort((a, b) => a.id - b.id);
  return { notices: items.length, ...await deliver(db, c.keys, (s) => summarize(items.filter((n) => s.kinds.includes(n.kind)))) };
}

async function testPush(req: Request) {
  await requireMember(req);
  const db = admin();
  const c = await config(db);
  return deliver(db, c.keys, () => ({ title: "Notifiche attive", body: "Da ora Yrols ti avvisa qui di movimenti, portafogli e offerte.", url: "/", tag: "yrols-test" }));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return json(req, 405, { error: "Usa POST" });
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    switch (body.action) {
      case "key": return json(req, 200, { publicKey: (await config(admin())).keys.publicKey });
      case "send": return json(req, 200, await send(req));
      case "test": return json(req, 200, await testPush(req));
      default: return json(req, 400, { error: "Azione sconosciuta" });
    }
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error("yrols-push", (e as Error).message);
    return json(req, status, { error: status === 500 ? "Errore interno" : (e as Error).message });
  }
});
