import { randomBytes } from "node:crypto";
import { EnableBankingClient, EnableBankingError } from "./client.js";
import { normalizeAccount, normalizeBalance, normalizeTransaction } from "./normalize.js";
import { pushToYrols, type PushOptions, type PushResult } from "./push.js";
import type { ConnectorStore, StoredConnection } from "./store.js";
import type { Account, Balance, Connection, SyncPayload, Transaction } from "./types.js";

export interface BankingServiceOptions {
  client: EnableBankingClient;
  store: ConnectorStore;
  redirectUrl: string;
  /** Giorni di validità del consenso richiesto alla banca (default 90). */
  consentDays?: number;
  /** Giorni di storico movimenti alla prima sincronizzazione (default 90). */
  initialHistoryDays?: number;
  now?: () => Date;
}

export interface SyncError {
  connectionId: string;
  accountId?: string;
  step: "balances" | "transactions" | "session";
  message: string;
  status?: number;
}

export interface SyncResult {
  payload: SyncPayload;
  errors: SyncError[];
  pushed?: PushResult;
}

const PENDING_TTL_MS = 60 * 60 * 1000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export class ConnectorError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "ConnectorError";
  }
}

export class BankingService {
  readonly client: EnableBankingClient;
  private readonly store: ConnectorStore;
  private readonly redirectUrl: string;
  private readonly consentDays: number;
  private readonly initialHistoryDays: number;
  private readonly now: () => Date;

  constructor(opts: BankingServiceOptions) {
    this.client = opts.client;
    this.store = opts.store;
    this.redirectUrl = opts.redirectUrl;
    this.consentDays = opts.consentDays ?? 90;
    this.initialHistoryDays = opts.initialHistoryDays ?? 90;
    this.now = opts.now ?? (() => new Date());
  }

  listBanks(country = "IT") {
    return this.client.listAspsps(country);
  }

  /** Passo 1 del consenso: restituisce l'URL della banca. */
  async startConnection(bankName: string, country = "IT"): Promise<{ url: string; state: string }> {
    if (!bankName) throw new ConnectorError("bankName obbligatorio");
    const now = this.now();
    const state = randomBytes(16).toString("hex");
    const validUntil = new Date(now.getTime() + this.consentDays * 86_400_000).toISOString();
    const auth = await this.client.startAuthorization({
      access: { valid_until: validUntil },
      aspsp: { name: bankName, country },
      state,
      redirect_url: this.redirectUrl,
      psu_type: "personal",
    });
    const data = await this.store.load();
    data.pending = data.pending.filter((p) => now.getTime() - Date.parse(p.createdAt) < PENDING_TTL_MS);
    data.pending.push({ state, bankName, country, createdAt: now.toISOString() });
    await this.store.save(data);
    return { url: auth.url, state };
  }

  /** Passo 2: la banca rimanda a redirect_url con ?code=&state=. */
  async completeConnection(code: string, state: string): Promise<StoredConnection> {
    if (!code) throw new ConnectorError("code mancante");
    const data = await this.store.load();
    const pending = data.pending.find((p) => p.state === state);
    if (!pending || this.now().getTime() - Date.parse(pending.createdAt) > PENDING_TTL_MS) {
      throw new ConnectorError("state non valido o scaduto: riavvia il collegamento della banca", 400);
    }
    const session = await this.client.createSession(code);
    const bankName = session.aspsp?.name ?? pending.bankName;
    const conn: StoredConnection = {
      id: session.session_id,
      bankName,
      country: session.aspsp?.country ?? pending.country,
      validUntil: session.access?.valid_until ?? "",
      status: "active",
      createdAt: this.now().toISOString(),
      accounts: (session.accounts ?? []).map((a) => normalizeAccount(a, bankName, session.session_id)),
    };
    const fresh = await this.store.load();
    fresh.pending = fresh.pending.filter((p) => p.state !== state);
    fresh.connections = [...fresh.connections.filter((c) => c.id !== conn.id), conn];
    await this.store.save(fresh);
    return conn;
  }

  private withStatus(c: StoredConnection): StoredConnection {
    if (c.status === "active" && c.validUntil && Date.parse(c.validUntil) < this.now().getTime()) {
      return { ...c, status: "expired" };
    }
    return c;
  }

  async listConnections(): Promise<Connection[]> {
    const data = await this.store.load();
    return data.connections.map((c) => {
      const { accounts: _a, createdAt: _c, ...rest } = this.withStatus(c);
      return rest;
    });
  }

  async listAccounts(): Promise<Account[]> {
    const data = await this.store.load();
    return data.connections
      .map((c) => this.withStatus(c))
      .filter((c) => c.status === "active")
      .flatMap((c) => c.accounts);
  }

  private async requireAccount(accountId: string): Promise<Account> {
    const acc = (await this.listAccounts()).find((a) => a.id === accountId);
    if (!acc) throw new ConnectorError(`Conto ${accountId} non trovato o consenso scaduto`, 404);
    return acc;
  }

  async getBalances(accountId: string): Promise<Balance[]> {
    await this.requireAccount(accountId);
    const res = await this.client.getBalances(accountId);
    return (res.balances ?? []).map((b) => normalizeBalance(b, accountId, this.now()));
  }

  async getTransactions(accountId: string, from?: string, to?: string): Promise<Transaction[]> {
    await this.requireAccount(accountId);
    const dateFrom = from ?? isoDay(new Date(this.now().getTime() - this.initialHistoryDays * 86_400_000));
    const raw = await this.client.getAllTransactions(accountId, { dateFrom, dateTo: to });
    return dedupe(raw.map((t) => normalizeTransaction(t, accountId)));
  }

  async disconnect(connectionId: string): Promise<void> {
    const data = await this.store.load();
    const conn = data.connections.find((c) => c.id === connectionId);
    if (!conn) throw new ConnectorError("Connessione non trovata", 404);
    try {
      await this.client.deleteSession(connectionId);
    } catch (err) {
      if (!(err instanceof EnableBankingError && [404, 410, 422].includes(err.status))) throw err;
    }
    conn.status = "revoked";
    await this.store.save(data);
  }

  /**
   * Raccoglie conti, saldi e movimenti di tutte le connessioni attive.
   * Prima sync: ultimi `initialHistoryDays` giorni; poi incrementale da
   * lastSyncAt meno 7 giorni (per recuperare i movimenti contabilizzati in ritardo).
   */
  async buildSyncPayload(opts: { from?: string } = {}): Promise<{ payload: SyncPayload; errors: SyncError[] }> {
    const data = await this.store.load();
    const now = this.now();
    const from =
      opts.from ??
      isoDay(
        data.lastSyncAt
          ? new Date(Date.parse(data.lastSyncAt) - 7 * 86_400_000)
          : new Date(now.getTime() - this.initialHistoryDays * 86_400_000),
      );
    const errors: SyncError[] = [];
    const connections = data.connections.map((c) => this.withStatus(c));
    const payload: SyncPayload = {
      source: "enablebanking",
      syncedAt: now.toISOString(),
      connections: connections.map(({ accounts: _a, createdAt: _c, ...rest }) => rest),
      accounts: [],
      balances: [],
      transactions: [],
    };
    for (const conn of connections.filter((c) => c.status === "active")) {
      for (const acc of conn.accounts) {
        payload.accounts!.push(acc);
        try {
          const res = await this.client.getBalances(acc.id);
          payload.balances!.push(...(res.balances ?? []).map((b) => normalizeBalance(b, acc.id, now)));
        } catch (err) {
          errors.push(toSyncError(err, conn.id, acc.id, "balances"));
        }
        try {
          const raw = await this.client.getAllTransactions(acc.id, { dateFrom: from });
          payload.transactions!.push(...dedupe(raw.map((t) => normalizeTransaction(t, acc.id))));
        } catch (err) {
          errors.push(toSyncError(err, conn.id, acc.id, "transactions"));
        }
      }
    }
    return { payload, errors };
  }

  /** Sincronizza e, se configurato, invia i dati al cruscotto. */
  async sync(push?: PushOptions, opts: { from?: string } = {}): Promise<SyncResult> {
    const { payload, errors } = await this.buildSyncPayload(opts);
    let pushed: PushResult | undefined;
    if (push) pushed = await pushToYrols(payload, push);
    // Avanza lastSyncAt solo se almeno una parte è andata a buon fine.
    const attempted = (payload.accounts?.length ?? 0) * 2;
    if (attempted === 0 || errors.length < attempted) {
      const data = await this.store.load();
      data.lastSyncAt = payload.syncedAt;
      await this.store.save(data);
    }
    return { payload, errors, pushed };
  }
}

function dedupe(txs: Transaction[]): Transaction[] {
  const seen = new Map<string, Transaction>();
  for (const t of txs) seen.set(t.id, t);
  return [...seen.values()];
}

function toSyncError(err: unknown, connectionId: string, accountId: string, step: SyncError["step"]): SyncError {
  return {
    connectionId,
    accountId,
    step,
    message: err instanceof Error ? err.message : String(err),
    status: err instanceof EnableBankingError ? err.status : undefined,
  };
}
