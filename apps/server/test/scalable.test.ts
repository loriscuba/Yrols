import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  authorizeUrl, buildSnapshot, parseRpc, pkceChallenge, readAll, ScalableError, ScalableMcp, toolPayload,
} from "../../../supabase/functions/_shared/scalable.ts";

// Dati inventati: il repo è pubblico, nessun portafoglio reale nei test.
const overview = { portfolioId: "pf-123", valuation: { total: 12500.5, securities: 12000.25, crypto: 500.25 }, timestamps: {}, performance: [] };
const cash = { portfolioId: "pf-123", cash: { cashBalance: 321.456, buyingPower: 321.45, buyingPowerWithoutCredit: 321.45, pendingBuyOrdersAmount: 0, estimatedTaxes: null } };
const holdings = {
  portfolioId: "pf-123",
  holdings: [
    { isin: "IE00B4L5Y983", name: "ETF Mondo", currentQuote: { currency: "EUR", midPrice: 100.5, timestamp: "x" }, savingsPlan: null, position: { blocked: 0, filled: 10, pending: 0 } },
    { isin: "DE0000000001", name: "Venduto", currentQuote: { currency: "EUR", midPrice: 5, timestamp: "x" }, savingsPlan: null, position: { blocked: 0, filled: 0, pending: 0 } },
    { isin: "US0000000002", name: "Senza prezzo", currentQuote: null, savingsPlan: null, position: { blocked: 0, filled: 2.5, pending: 0 } },
  ],
  cryptoHoldings: [],
};

test("PKCE S256 e URL di autorizzazione", async () => {
  const v = "verificatore-di-prova-abcdefghijklmnopqrstuvwxyz0123456789";
  const expected = createHash("sha256").update(v).digest("base64url");
  assert.equal(await pkceChallenge(v), expected);
  const u = new URL(authorizeUrl({ clientId: "c1", redirectUri: "https://example.org/cb/", state: "sc-abc", challenge: expected }));
  assert.equal(u.origin + u.pathname, "https://mcp.scalable.capital/authorize");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("resource"), "https://mcp.scalable.capital/mcp");
  assert.match(u.searchParams.get("scope")!, /offline_access/);
  assert.equal(u.searchParams.get("state"), "sc-abc");
});

test("risposte JSON-RPC in JSON e in SSE", () => {
  assert.deepEqual(parseRpc('{"jsonrpc":"2.0","id":3,"result":{"a":1}}', "application/json", 3).result, { a: 1 });
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
  assert.deepEqual(parseRpc(sse, "text/event-stream", 2).result, { ok: true });
  assert.throws(() => parseRpc(sse, "text/event-stream", 9), ScalableError);
});

test("contenuto degli strumenti: structuredContent, testo JSON, errori", () => {
  assert.deepEqual(toolPayload("x", { structuredContent: { a: 1 } }), { a: 1 });
  assert.deepEqual(toolPayload("x", { content: [{ type: "text", text: '{"b":2}' }] }), { b: 2 });
  assert.throws(() => toolPayload("x", { structuredContent: { error: { code: "auth_invalid", message: "no" } } }),
    (e: ScalableError) => e.needsLogin && e.code === "auth_invalid");
  assert.throws(() => toolPayload("x", { isError: true, content: [{ type: "text", text: "rotto" }] }), /rotto/);
});

test("conti, saldi e posizioni da Scalable", () => {
  const s = buildSnapshot([{ portfolioId: "pf-123", displayName: "Broker", overview, cash, holdings }],
    { savingsAccountId: "ov-9", account: { displayName: "Conto Interessi" }, summary: { balance: "1500.10" } }, "2026-11-19");
  assert.deepEqual(s.accounts.map((a) => [a.id, a.name]), [
    ["scalable-pf123-titoli", "Portafoglio titoli"], ["scalable-pf123-cash", "Liquidità broker"], ["scalable-overnight-ov9", "Conto Interessi"],
  ]);
  assert.deepEqual(s.balances.map((b) => [b.accountId, b.amount, b.type]), [
    ["scalable-pf123-titoli", 12500.5, "VALU"], ["scalable-pf123-cash", 321.46, "ITAV"], ["scalable-overnight-ov9", 1500.1, "ITAV"],
  ]);
  assert.deepEqual(s.holdings.map((h) => [h.isin, h.quantity, h.value]), [["IE00B4L5Y983", 10, 1005], ["US0000000002", 2.5, null]]);
});

test("valori mancanti: niente conti inventati, nomi distinti con più portafogli", () => {
  assert.deepEqual(buildSnapshot([{ portfolioId: "p", overview: { valuation: { total: null, securities: null, crypto: null } } }], null, "2026-11-19").accounts, []);
  const two = buildSnapshot([
    { portfolioId: "a1", displayName: "Uno", overview: { valuation: { total: 1 } } },
    { portfolioId: "b2", displayName: "Due", overview: { valuation: { total: 2 } } },
  ], { summary: { balance: "non numero" } }, "2026-11-19");
  assert.deepEqual(two.accounts.map((a) => a.name), ["Portafoglio titoli Uno", "Portafoglio titoli Due"]);
});

test("client MCP: sessione, notifica initialized e lettura completa con un finto server", async () => {
  const seen: { method: string; session: string | null; auth: string | null }[] = [];
  const tools: Record<string, unknown> = {
    list_accessible_portfolios: { portfolios: [{ portfolioId: "pf-123", displayName: null }], resolution: { status: "auto_resolved", autoResolvedPortfolioId: "pf-123" } },
    get_portfolio_overview: overview, get_portfolio_cash_breakdown: cash, get_portfolio_holdings: holdings,
    get_overnight_summary: { error: { code: "resource_not_found", message: "nessun conto" } },
  };
  const fake = (async (_url: string, init: RequestInit) => {
    const h = new Headers(init.headers);
    const msg = JSON.parse(String(init.body));
    seen.push({ method: msg.method, session: h.get("Mcp-Session-Id"), auth: h.get("Authorization") });
    if (msg.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result = msg.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: {} } : { structuredContent: tools[msg.params.name] };
    const body = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`;
    return new Response(body, { headers: { "Content-Type": "text/event-stream", "Mcp-Session-Id": "sess-1" } });
  }) as typeof fetch;
  const data = await readAll(new ScalableMcp("tok", fake));
  assert.equal(seen[0]!.method, "initialize");
  assert.equal(seen[0]!.session, null);
  assert.ok(seen.slice(1).every((x) => x.session === "sess-1" && x.auth === "Bearer tok"));
  assert.equal(data.portfolios.length, 1);
  assert.equal(data.overnight, null, "conto overnight assente: ignorato");
  assert.equal(buildSnapshot(data.portfolios, data.overnight, "2026-11-19").accounts.length, 2);
});

test("client MCP: 401 = accesso da rinnovare", async () => {
  const fake = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(new ScalableMcp("tok", fake).init(), (e: ScalableError) => e.needsLogin);
});

test("indirizzo incollato dopo il login (pagina locale 127.0.0.1)", async () => {
  const { parsePasted } = await import("../../web/src/scalablePaste.ts");
  assert.deepEqual(parsePasted(" 127.0.0.1:53682/yrols-scalable?code=abc&state=sc-xyz "), { state: "sc-xyz", code: "abc", error: undefined });
  assert.deepEqual(parsePasted("http://127.0.0.1:53682/yrols-scalable?error=access_denied&state=sc-1"), { state: "sc-1", code: undefined, error: "access_denied" });
  assert.equal(parsePasted("https://x/?code=1&state=gm-1"), null, "solo gli accessi Scalable");
  assert.equal(parsePasted("http://127.0.0.1:53682/yrols-scalable?state=sc-1"), null);
  assert.equal(parsePasted("boh"), null);
});
