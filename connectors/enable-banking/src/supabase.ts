import type { PushResult } from "./push.js";
import type { SyncPayload } from "./types.js";

export interface SupabasePushOptions {
  /** https://<ref>.supabase.co */
  url: string;
  /** service_role key: solo nei secret di GitHub Actions o nel .env locale, mai nel browser. */
  serviceKey: string;
  /** Nome della funzione Postgres che accetta il payload del contratto v1. */
  rpc?: string;
  /** Schema Postgres della funzione (es. "yrols"); deve essere tra gli "Exposed schemas" dell'API. */
  schema?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Invia il payload al database Supabase del cruscotto: POST /rest/v1/rpc/<rpc> { payload }. */
export async function pushToSupabase(payload: SyncPayload, opts: SupabasePushOptions): Promise<PushResult> {
  const f = opts.fetch ?? globalThis.fetch;
  const url = `${opts.url.replace(/\/+$/, "")}/rest/v1/rpc/${opts.rpc ?? "yrols_bank_sync"}`;
  const res = await f(url, {
    method: "POST",
    headers: {
      apikey: opts.serviceKey,
      Authorization: `Bearer ${opts.serviceKey}`,
      "Content-Type": "application/json",
      // PostgREST: per uno schema diverso da public si indica il profilo nella richiesta.
      ...(opts.schema && opts.schema !== "public" ? { "Content-Profile": opts.schema, "Accept-Profile": opts.schema } : {}),
    },
    body: JSON.stringify({ payload }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });
  const text = await res.text();
  // Il corpo d'errore di PostgREST non contiene dati del payload, solo codice e messaggio.
  if (!res.ok) throw new Error(`Push verso Supabase fallito (${res.status}): ${text.slice(0, 300)}`);
  const body = text ? (JSON.parse(text) as unknown) : null;
  return body && typeof body === "object" && !Array.isArray(body) ? { ok: true, ...(body as object) } : { ok: true };
}
