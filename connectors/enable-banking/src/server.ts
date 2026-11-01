import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { EnableBankingClient, EnableBankingError } from "./client.js";
import { loadConfig, type ConnectorConfig } from "./config.js";
import { BankingService, ConnectorError } from "./service.js";
import { FileStore, JsonStateStore, type ConnectorStore } from "./store.js";
import type { Pusher } from "./push.js";

export interface AppOptions {
  service: BankingService;
  apiToken?: string;
  corsOrigin?: string;
  dashboardUrl?: string;
  push?: Pusher;
  log?: (msg: string) => void;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new HttpError(413, "Payload troppo grande");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "JSON non valido");
  }
}

function tokenOk(header: string | undefined, expected: string): boolean {
  const got = Buffer.from(header?.replace(/^Bearer\s+/i, "") ?? "");
  const exp = Buffer.from(expected);
  return got.length === exp.length && timingSafeEqual(got, exp);
}

function withQuery(base: string, params: Record<string, string>): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

export function createApp(opts: AppOptions): Server {
  return createServer(createHandler(opts));
}

export function createHandler(opts: AppOptions): RequestListener {
  const { service } = opts;
  const log = opts.log ?? ((m: string) => console.log(m));

  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";

    if (opts.corsOrigin) {
      res.setHeader("Access-Control-Allow-Origin", opts.corsOrigin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    }
    if (method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    try {
      if (path === "/health") return send(res, 200, { ok: true });

      // Ritorno dalla banca: non protetto da token (lo apre il browser), protetto da `state`.
      if (path === "/api/banks/callback" && method === "GET") {
        const error = url.searchParams.get("error");
        const code = url.searchParams.get("code") ?? "";
        const state = url.searchParams.get("state") ?? "";
        let result: Record<string, string>;
        if (error) {
          result = { bank: "error", reason: url.searchParams.get("error_description") ?? error };
        } else {
          try {
            const conn = await service.completeConnection(code, state);
            result = { bank: "connected", connection: conn.id };
            // Prima sincronizzazione in background, così il cruscotto si popola subito.
            if (opts.push) {
              service.sync(opts.push).then(
                (r) => log(`[sync] dopo collegamento: ${r.payload.transactions?.length ?? 0} movimenti, ${r.errors.length} errori`),
                (e) => log(`[sync] dopo collegamento fallita: ${(e as Error).message}`),
              );
            }
          } catch (e) {
            result = { bank: "error", reason: (e as Error).message };
          }
        }
        if (opts.dashboardUrl) {
          res.writeHead(302, { Location: withQuery(opts.dashboardUrl, result) }).end();
          return;
        }
        return send(res, result.bank === "connected" ? 200 : 400, result);
      }

      if (opts.apiToken && !tokenOk(req.headers.authorization, opts.apiToken)) {
        throw new HttpError(401, "Token mancante o non valido");
      }

      if (path === "/api/banks/aspsps" && method === "GET") {
        return send(res, 200, { aspsps: await service.listBanks(url.searchParams.get("country") ?? "IT") });
      }
      if (path === "/api/banks/connect" && method === "POST") {
        const body = await readJson(req);
        const out = await service.startConnection(String(body.bankName ?? ""), String(body.country ?? "IT"));
        return send(res, 200, { url: out.url });
      }
      if (path === "/api/banks/connections" && method === "GET") {
        return send(res, 200, { connections: await service.listConnections() });
      }
      let m = path.match(/^\/api\/banks\/connections\/([^/]+)$/);
      if (m && method === "DELETE") {
        await service.disconnect(decodeURIComponent(m[1]!));
        return send(res, 200, { ok: true });
      }
      if (path === "/api/banks/accounts" && method === "GET") {
        return send(res, 200, { accounts: await service.listAccounts() });
      }
      m = path.match(/^\/api\/banks\/accounts\/([^/]+)\/(balances|transactions)$/);
      if (m && method === "GET") {
        const id = decodeURIComponent(m[1]!);
        if (m[2] === "balances") return send(res, 200, { balances: await service.getBalances(id) });
        const from = url.searchParams.get("from") ?? undefined;
        const to = url.searchParams.get("to") ?? undefined;
        return send(res, 200, { transactions: await service.getTransactions(id, from, to) });
      }
      if (path === "/api/banks/sync" && method === "POST") {
        const body = await readJson(req);
        const r = await service.sync(opts.push, { from: typeof body.from === "string" ? body.from : undefined });
        return send(res, 200, {
          ok: true,
          pushed: r.pushed ?? null,
          counts: {
            connections: r.payload.connections?.length ?? 0,
            accounts: r.payload.accounts?.length ?? 0,
            balances: r.payload.balances?.length ?? 0,
            transactions: r.payload.transactions?.length ?? 0,
          },
          errors: r.errors,
          // Senza push configurato restituisce i dati, così il cruscotto può importarli da sé.
          ...(opts.push ? {} : { payload: r.payload }),
        });
      }
      throw new HttpError(404, "Endpoint non trovato");
    } catch (err) {
      if (err instanceof HttpError || err instanceof ConnectorError) return send(res, err.status, { error: err.message });
      if (err instanceof EnableBankingError) {
        log(`[enable-banking] ${err.message}`);
        return send(res, 502, { error: err.message, upstreamStatus: err.status });
      }
      log(`[errore] ${(err as Error).stack ?? err}`);
      return send(res, 500, { error: "Errore interno" });
    }
  };
}

export function buildService(cfg: ConnectorConfig): BankingService {
  const client = new EnableBankingClient({ applicationId: cfg.applicationId, privateKey: cfg.privateKey, baseUrl: cfg.baseUrl });
  return new BankingService({
    client,
    store: buildStore(cfg),
    redirectUrl: cfg.redirectUrl,
    consentDays: cfg.consentDays,
    initialHistoryDays: cfg.initialHistoryDays,
  });
}

export function buildStore(cfg: ConnectorConfig): ConnectorStore {
  // In GitHub Actions le sessioni arrivano dal secret EB_STATE (il disco non persiste tra un'esecuzione e l'altra).
  return cfg.stateJson ? new JsonStateStore(cfg.stateJson) : new FileStore(cfg.dataFile);
}

export function main() {
  const cfg = loadConfig();
  const service = buildService(cfg);
  if (!cfg.apiToken) {
    console.warn("ATTENZIONE: CONNECTOR_API_TOKEN non impostato, le API non sono protette. Usa solo in locale.");
    if (cfg.host !== "127.0.0.1" && cfg.host !== "localhost") {
      throw new Error("Rifiuto di esporre il connettore su una rete senza CONNECTOR_API_TOKEN");
    }
  }
  const handler = createHandler({ service, apiToken: cfg.apiToken, corsOrigin: cfg.corsOrigin, dashboardUrl: cfg.dashboardUrl, push: cfg.push });
  // Enable Banking accetta solo redirect https: con TLS_CERT_PATH/TLS_KEY_PATH il server parla https.
  const tls = cfg.tlsCertPath && cfg.tlsKeyPath;
  const server = tls
    ? createHttpsServer({ cert: readFileSync(cfg.tlsCertPath!), key: readFileSync(cfg.tlsKeyPath!) }, handler)
    : createServer(handler);
  server.listen(cfg.port, cfg.host, () => {
    console.log(`Connettore Enable Banking in ascolto su ${tls ? "https" : "http"}://${cfg.host}:${cfg.port}`);
    console.log(cfg.pushTarget ? `Push verso: ${cfg.pushTarget}` : "Push verso il cruscotto disattivato (SUPABASE_URL o YROLS_URL)");
  });
  if (cfg.syncIntervalMinutes > 0 && cfg.push) {
    const run = () =>
      service.sync(cfg.push).then(
        (r) => console.log(`[sync] ${new Date().toISOString()} ${r.payload.transactions?.length ?? 0} movimenti, ${r.errors.length} errori`),
        (e) => console.error(`[sync] fallita: ${(e as Error).message}`),
      );
    setInterval(run, cfg.syncIntervalMinutes * 60_000).unref();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
