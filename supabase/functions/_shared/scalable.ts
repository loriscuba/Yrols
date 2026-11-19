// Scalable Capital tramite il server MCP ufficiale (Agentic Investing): OAuth pubblico con PKCE,
// chiamate JSON-RPC "Streamable HTTP" e conversione delle risposte in conti, saldi e posizioni di Yrols.
// Niente API Deno qui: lo usano la Edge Function yrols-scalable e i test Node (apps/server/test/scalable.test.ts).
//
// Strumenti usati (solo lettura): list_accessible_portfolios, get_portfolio_overview,
// get_portfolio_cash_breakdown, get_portfolio_holdings, get_overnight_summary.
// Scalable non garantisce la forma delle risposte: i campi si leggono in modo difensivo.

export const MCP_URL = "https://mcp.scalable.capital/mcp";
export const ISSUER = "https://mcp.scalable.capital";
export const SCOPE = "openid profile offline_access";
export const BANK_NAME = "Scalable Capital";
export const CONNECTION_ID = "scalable";

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

export function authorizeUrl(o: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const u = new URL(`${ISSUER}/authorize`);
  u.search = new URLSearchParams({
    response_type: "code", client_id: o.clientId, redirect_uri: o.redirectUri, scope: SCOPE,
    state: o.state, code_challenge: o.challenge, code_challenge_method: "S256", resource: MCP_URL,
  }).toString();
  return u.toString();
}

export class ScalableError extends Error {
  constructor(message: string, readonly status = 0, readonly code?: string) { super(message); }
  /** Il login va rifatto (token scaduto o revocato, accesso disattivato su Scalable). */
  get needsLogin() {
    return this.status === 401 || this.code === "invalid_grant" || this.code === "auth_required" || this.code === "auth_invalid";
  }
}

type Fetch = typeof fetch;

export interface Tokens { access_token: string; refresh_token?: string; expires_in?: number }

async function oauthPost(f: Fetch, path: string, form: Record<string, string>): Promise<Tokens> {
  const r = await f(`${ISSUER}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
  const j = await r.json().catch(() => ({})) as Record<string, unknown>;
  if (!r.ok || typeof j.access_token !== "string") {
    throw new ScalableError(`Scalable ha rifiutato il token (${r.status}${j.error ? `, ${j.error}` : ""})`, r.status, j.error as string | undefined);
  }
  return j as unknown as Tokens;
}

/** Registrazione dinamica del client pubblico (una volta sola, poi si riusa il client_id). */
export async function registerClient(f: Fetch, redirectUri: string): Promise<string> {
  const r = await f(`${ISSUER}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "Yrols", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"], token_endpoint_auth_method: "none", scope: SCOPE,
    }),
  });
  const j = await r.json().catch(() => ({})) as Record<string, unknown>;
  if (!r.ok || typeof j.client_id !== "string") {
    throw new ScalableError(`Registrazione su Scalable non riuscita (${r.status}${j.error_description ? `: ${j.error_description}` : j.error ? `: ${j.error}` : ""})`, r.status);
  }
  return j.client_id;
}

export const exchangeCode = (f: Fetch, o: { clientId: string; redirectUri: string; code: string; verifier: string }) =>
  oauthPost(f, "/token", {
    grant_type: "authorization_code", code: o.code, redirect_uri: o.redirectUri, client_id: o.clientId,
    code_verifier: o.verifier, resource: MCP_URL,
  });

export const refreshTokens = (f: Fetch, o: { clientId: string; refreshToken: string }) =>
  oauthPost(f, "/token", { grant_type: "refresh_token", refresh_token: o.refreshToken, client_id: o.clientId, resource: MCP_URL });

// ── MCP ─────────────────────────────────────────────────────────────────────

interface RpcMessage { jsonrpc: "2.0"; id?: number; result?: Record<string, unknown>; error?: { code: number; message: string } }

/** Legge una risposta JSON-RPC, sia JSON sia flusso SSE ("data: {...}"), e restituisce il messaggio con quell'id. */
export function parseRpc(body: string, contentType: string | null, id: number): RpcMessage {
  const msgs: RpcMessage[] = [];
  if ((contentType ?? "").includes("text/event-stream")) {
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (data) { try { msgs.push(JSON.parse(data)); } catch { /* evento non JSON */ } }
    }
  } else if (body.trim()) {
    const j = JSON.parse(body);
    msgs.push(...(Array.isArray(j) ? j : [j]));
  }
  const m = msgs.find((x) => x.id === id);
  if (!m) throw new ScalableError("Risposta MCP di Scalable senza risultato");
  return m;
}

/** Contenuto di un tools/call: structuredContent, altrimenti il primo testo JSON. Errori come ScalableError. */
export function toolPayload(name: string, result: Record<string, unknown> | undefined): Record<string, unknown> {
  let data = result?.structuredContent as Record<string, unknown> | undefined;
  if (!data) {
    const text = (result?.content as { type: string; text?: string }[] | undefined)?.find((c) => c.type === "text")?.text;
    if (text) { try { data = JSON.parse(text); } catch { if (result?.isError) throw new ScalableError(`${name}: ${text.slice(0, 200)}`); } }
  }
  const err = data?.error as { code?: string; message?: string } | undefined;
  if (err?.code) throw new ScalableError(`${name}: ${err.message ?? err.code}`, 0, err.code);
  if (result?.isError || !data) throw new ScalableError(`${name}: risposta non valida`);
  return data;
}

export class ScalableMcp {
  private session: string | null = null;
  private nextId = 1;
  constructor(private token: string, private f: Fetch = fetch) {}

  private async rpc(method: string, params?: Record<string, unknown>, notify = false): Promise<RpcMessage | null> {
    const id = notify ? undefined : this.nextId++;
    const r = await this.f(MCP_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18", ...(this.session && { "Mcp-Session-Id": this.session }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", method, ...(id !== undefined && { id }), ...(params && { params }) }),
    });
    const sid = r.headers.get("Mcp-Session-Id");
    if (sid) this.session = sid;
    const body = await r.text();
    if (r.status === 401 || r.status === 403) throw new ScalableError("Accesso a Scalable scaduto: rinnova dalla pagina Banche", 401);
    if (!r.ok) throw new ScalableError(`Server MCP di Scalable: errore ${r.status}`, r.status);
    if (notify) return null;
    const m = parseRpc(body, r.headers.get("Content-Type"), id!);
    if (m.error) throw new ScalableError(`Server MCP di Scalable: ${m.error.message}`);
    return m;
  }

  async init() {
    await this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Yrols", version: "1.0" } });
    await this.rpc("notifications/initialized", undefined, true);
  }

  async call(name: string, args: Record<string, unknown> = {}) {
    const m = await this.rpc("tools/call", { name, arguments: args });
    return toolPayload(name, m!.result);
  }
}

// ── Conversione in dati Yrols ───────────────────────────────────────────────

const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface PortfolioData {
  portfolioId: string;
  displayName?: string | null;
  overview?: Record<string, unknown> | null;
  cash?: Record<string, unknown> | null;
  holdings?: Record<string, unknown> | null;
}
export interface OvernightData { savingsAccountId?: string; account?: { displayName?: string }; summary?: { balance?: unknown } }

export interface Snapshot {
  accounts: { id: string; name: string; currency: string }[];
  balances: { accountId: string; amount: number; type: string; date: string }[];
  holdings: { accountId: string; isin: string; name: string; quantity: number; price: number | null; currency: string; value: number | null }[];
}

const slug = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "").slice(-12) || "0";

/** Conti Yrols: per ogni portafoglio "Titoli" (valore di mercato) e "Liquidità"; più l'eventuale conto overnight. */
export function buildSnapshot(portfolios: PortfolioData[], overnight: OvernightData | null, today: string): Snapshot {
  const s: Snapshot = { accounts: [], balances: [], holdings: [] };
  const many = portfolios.length > 1;
  for (const p of portfolios) {
    const key = `scalable-${slug(p.portfolioId)}`;
    const label = many && p.displayName ? ` ${p.displayName}` : "";
    const val = (p.overview?.valuation ?? {}) as Record<string, unknown>;
    const sec = num(val.securities), cry = num(val.crypto), tot = num(val.total);
    const invested = sec !== null || cry !== null ? (sec ?? 0) + (cry ?? 0) : tot;
    if (invested !== null) {
      s.accounts.push({ id: `${key}-titoli`, name: `Portafoglio titoli${label}`, currency: "EUR" });
      s.balances.push({ accountId: `${key}-titoli`, amount: round2(invested), type: "VALU", date: today });
    }
    const cash = num(((p.cash?.cash ?? {}) as Record<string, unknown>).cashBalance);
    if (cash !== null) {
      s.accounts.push({ id: `${key}-cash`, name: `Liquidità broker${label}`, currency: "EUR" });
      s.balances.push({ accountId: `${key}-cash`, amount: round2(cash), type: "ITAV", date: today });
    }
    if (invested !== null) {
      for (const h of (p.holdings?.holdings ?? []) as Record<string, unknown>[]) {
        const pos = (h.position ?? {}) as Record<string, unknown>;
        const quote = (h.currentQuote ?? {}) as Record<string, unknown>;
        const qty = num(pos.filled) ?? 0;
        if (!h.isin || qty <= 0) continue;
        const price = num(quote.midPrice);
        s.holdings.push({
          accountId: `${key}-titoli`, isin: String(h.isin), name: String(h.name ?? h.isin), quantity: qty, price,
          currency: typeof quote.currency === "string" ? quote.currency : "EUR", value: price === null ? null : round2(qty * price),
        });
      }
    }
  }
  const ob = num(overnight?.summary?.balance);
  if (overnight && ob !== null) {
    const id = `scalable-overnight-${slug(overnight.savingsAccountId ?? "0")}`;
    s.accounts.push({ id, name: overnight.account?.displayName || "Conto overnight", currency: "EUR" });
    s.balances.push({ accountId: id, amount: round2(ob), type: "ITAV", date: today });
  }
  return s;
}

/** Legge tutto quello che serve dal server MCP. Il conto overnight è facoltativo: se manca si ignora. */
export async function readAll(mcp: ScalableMcp): Promise<{ portfolios: PortfolioData[]; overnight: OvernightData | null }> {
  await mcp.init();
  const list = await mcp.call("list_accessible_portfolios");
  const ps = ((list.portfolios ?? []) as { portfolioId: string; displayName?: string | null }[]).filter((p) => p.portfolioId);
  const portfolios: PortfolioData[] = [];
  for (const p of ps) {
    const args = { portfolioId: p.portfolioId };
    const [overview, cash, holdings] = await Promise.all([
      mcp.call("get_portfolio_overview", args),
      mcp.call("get_portfolio_cash_breakdown", args).catch(() => null),
      mcp.call("get_portfolio_holdings", args).catch(() => null),
    ]);
    portfolios.push({ ...p, overview, cash, holdings });
  }
  const overnight = await mcp.call("get_overnight_summary").then((o) => o as OvernightData, () => null);
  return { portfolios, overnight };
}
