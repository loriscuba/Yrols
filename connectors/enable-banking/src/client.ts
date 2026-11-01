import type { KeyObject } from "node:crypto";
import { createJwt, loadPrivateKey } from "./jwt.js";
import type {
  EbAccount,
  EbAspsp,
  EbAuthRequest,
  EbAuthResponse,
  EbBalancesResponse,
  EbSession,
  EbSessionStatus,
  EbTransaction,
  EbTransactionsResponse,
} from "./types.js";

export interface EnableBankingClientOptions {
  applicationId: string;
  privateKey: string | KeyObject;
  baseUrl?: string;
  /** Durata del JWT in secondi (default 1h, max 24h). */
  jwtTtlSeconds?: number;
  /** Iniettabile per i test. */
  fetch?: typeof fetch;
  /** Timeout per richiesta in ms (default 30s). */
  timeoutMs?: number;
}

export class EnableBankingError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
    readonly path: string,
  ) {
    super(message);
    this.name = "EnableBankingError";
  }
}

export interface TransactionsQuery {
  dateFrom?: string;
  dateTo?: string;
  continuationKey?: string;
  transactionStatus?: string;
}

export class EnableBankingClient {
  readonly baseUrl: string;
  private readonly applicationId: string;
  private readonly key: KeyObject;
  private readonly ttl: number;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private cachedJwt?: { token: string; expiresAt: number };

  constructor(opts: EnableBankingClientOptions) {
    this.applicationId = opts.applicationId;
    this.key = loadPrivateKey(opts.privateKey);
    this.baseUrl = (opts.baseUrl ?? "https://api.enablebanking.com").replace(/\/+$/, "");
    this.ttl = opts.jwtTtlSeconds ?? 3600;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private authHeader(): string {
    // Rinnova il token con un minuto di margine.
    if (!this.cachedJwt || this.cachedJwt.expiresAt - 60_000 < Date.now()) {
      this.cachedJwt = createJwt(this.applicationId, this.key, this.ttl);
    }
    return `Bearer ${this.cachedJwt.token}`;
  }

  async request<T>(method: string, path: string, body?: unknown, query?: Record<string, string | undefined>): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, v);
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        Authorization: this.authHeader(),
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      const detail =
        parsed && typeof parsed === "object" && "message" in parsed ? String((parsed as { message: unknown }).message) : text.slice(0, 300);
      throw new EnableBankingError(`Enable Banking ${method} ${path} -> ${res.status}: ${detail}`, res.status, parsed, path);
    }
    return parsed as T;
  }

  getApplication() {
    return this.request<Record<string, unknown>>("GET", "/application");
  }

  async listAspsps(country?: string, psuType: "personal" | "business" = "personal"): Promise<EbAspsp[]> {
    const res = await this.request<{ aspsps: EbAspsp[] }>("GET", "/aspsps", undefined, { country, psu_type: psuType });
    return res.aspsps ?? [];
  }

  /** Avvia il consenso: restituisce l'URL della banca su cui mandare l'utente. */
  startAuthorization(req: EbAuthRequest): Promise<EbAuthResponse> {
    return this.request<EbAuthResponse>("POST", "/auth", { psu_type: "personal", ...req });
  }

  /** Scambia il `code` ricevuto sulla redirect URL con una sessione. */
  createSession(code: string): Promise<EbSession> {
    return this.request<EbSession>("POST", "/sessions", { code });
  }

  getSession(sessionId: string): Promise<EbSessionStatus> {
    return this.request<EbSessionStatus>("GET", `/sessions/${encodeURIComponent(sessionId)}`);
  }

  deleteSession(sessionId: string): Promise<unknown> {
    return this.request("DELETE", `/sessions/${encodeURIComponent(sessionId)}`);
  }

  getAccountDetails(accountUid: string): Promise<EbAccount> {
    return this.request<EbAccount>("GET", `/accounts/${encodeURIComponent(accountUid)}/details`);
  }

  getBalances(accountUid: string): Promise<EbBalancesResponse> {
    return this.request<EbBalancesResponse>("GET", `/accounts/${encodeURIComponent(accountUid)}/balances`);
  }

  getTransactionsPage(accountUid: string, q: TransactionsQuery = {}): Promise<EbTransactionsResponse> {
    return this.request<EbTransactionsResponse>("GET", `/accounts/${encodeURIComponent(accountUid)}/transactions`, undefined, {
      date_from: q.dateFrom,
      date_to: q.dateTo,
      continuation_key: q.continuationKey,
      transaction_status: q.transactionStatus,
    });
  }

  /** Scorre tutte le pagine (continuation_key) fino a esaurimento. */
  async getAllTransactions(accountUid: string, q: Omit<TransactionsQuery, "continuationKey"> = {}, maxPages = 100): Promise<EbTransaction[]> {
    const all: EbTransaction[] = [];
    let continuationKey: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.getTransactionsPage(accountUid, { ...q, continuationKey });
      all.push(...(res.transactions ?? []));
      if (!res.continuation_key || res.continuation_key === continuationKey) break;
      continuationKey = res.continuation_key;
    }
    return all;
  }
}
