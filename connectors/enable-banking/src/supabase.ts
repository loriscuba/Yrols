import type { ConnectorStore, StoreData, StoredConnection } from "./store.js";
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


interface ConnRow { id: string; bank_name: string | null; country: string | null; valid_until: string | null; status: string | null; updated_at?: string }
interface AccRow { id: string; connection_id: string | null; bank_name: string | null; name: string | null; iban: string | null; currency: string | null; eb_uid: string | null }

/**
 * Legge le connessioni bancarie dal database del cruscotto (tabelle bank_connections e bank_accounts),
 * dove le scrive l'Edge Function yrols-bank-auth quando si collega o rinnova una banca dall'app.
 * Così GitHub Actions non ha più bisogno del secret EB_STATE. Le scritture passano dalla RPC di sync.
 */
export class SupabaseStore implements ConnectorStore {
  private lastSyncAt?: string;
  constructor(private readonly opts: Omit<SupabasePushOptions, "rpc">) {}

  private async get<T>(path: string): Promise<T> {
    const f = this.opts.fetch ?? globalThis.fetch;
    const schema = this.opts.schema ?? "yrols";
    const res = await f(`${this.opts.url.replace(/\/+$/, "")}/rest/v1/${path}`, {
      headers: {
        apikey: this.opts.serviceKey,
        Authorization: `Bearer ${this.opts.serviceKey}`,
        Accept: "application/json",
        ...(schema !== "public" ? { "Accept-Profile": schema } : {}),
      },
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Lettura da Supabase fallita (${res.status}): ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  }

  async load(): Promise<StoreData> {
    const [conns, accs] = await Promise.all([
      this.get<ConnRow[]>("bank_connections?select=id,bank_name,country,valid_until,status,updated_at&status=neq.revoked"),
      this.get<AccRow[]>("bank_accounts?select=id,connection_id,bank_name,name,iban,currency,eb_uid&source=eq.enablebanking"),
    ]);
    const connections: StoredConnection[] = conns.map((c) => ({
      id: c.id,
      bankName: c.bank_name ?? "",
      country: c.country ?? "",
      validUntil: c.valid_until ?? "",
      status: c.status === "expired" ? "expired" : "active",
      createdAt: c.updated_at ?? "",
      accounts: accs
        .filter((a) => a.connection_id === c.id)
        .map((a) => ({
          id: a.id,
          connectionId: c.id,
          ...(a.iban ? { iban: a.iban } : {}),
          ...(a.name ? { name: a.name } : {}),
          ...(a.currency ? { currency: a.currency } : {}),
          ...(a.bank_name ? { bankName: a.bank_name } : {}),
          ...(a.eb_uid && a.eb_uid !== a.id ? { ebUid: a.eb_uid } : {}),
        })),
    }));
    return { pending: [], connections, lastSyncAt: this.lastSyncAt };
  }

  /** Le connessioni le gestisce l'app: qui si conserva solo lastSyncAt per la durata del processo. */
  async save(data: StoreData): Promise<void> {
    this.lastSyncAt = data.lastSyncAt;
  }
}
