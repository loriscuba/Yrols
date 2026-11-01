import type { SyncPayload } from "./types.js";

export interface PushOptions {
  /** URL base del cruscotto, es. http://localhost:4000 */
  yrolsUrl: string;
  /** Deve coincidere con YROLS_INGEST_TOKEN del server del cruscotto. */
  ingestToken: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface PushResult {
  ok: boolean;
  connections?: number;
  accounts?: number;
  balances?: number;
  transactions?: number;
  [k: string]: unknown;
}

/** Invia i dati normalizzati al cruscotto: POST {yrolsUrl}/api/banks/sync (upsert per id). */
export async function pushToYrols(payload: SyncPayload, opts: PushOptions): Promise<PushResult> {
  const f = opts.fetch ?? globalThis.fetch;
  const url = `${opts.yrolsUrl.replace(/\/+$/, "")}/api/banks/sync`;
  const res = await f(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.ingestToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Push verso Yrols fallito (${res.status}): ${text.slice(0, 300)}`);
  return text ? (JSON.parse(text) as PushResult) : { ok: true };
}
