import { test } from "node:test";
import assert from "node:assert/strict";
import { pushToSupabase } from "../src/supabase.js";
import { JsonStateStore, exportState } from "../src/store.js";
import { loadConfig } from "../src/config.js";
import { mockFetch, privateKey } from "./helpers.js";

const payload = { source: "enablebanking" as const, syncedAt: "2026-11-01T00:00:00Z", accounts: [{ id: "a" }] };

test("push verso Supabase: RPC con payload e service key", async () => {
  const m = mockFetch(() => ({ body: { ok: true, accounts: 1, billsMatched: 0 } }));
  const r = await pushToSupabase(payload, { url: "https://x.supabase.co/", serviceKey: "srv", fetch: m.fetch });
  const c = m.calls[0]!;
  assert.equal(c.url.toString(), "https://x.supabase.co/rest/v1/rpc/yrols_bank_sync");
  assert.equal(c.headers.apikey, "srv");
  assert.equal(c.headers.Authorization, "Bearer srv");
  assert.deepEqual(c.body, { payload });
  assert.equal(r.accounts, 1);
  assert.equal(c.headers["Content-Profile"], undefined);
});

test("push verso Supabase in uno schema dedicato", async () => {
  const m = mockFetch(() => ({ body: { ok: true } }));
  await pushToSupabase(payload, { url: "https://x.supabase.co", serviceKey: "k", schema: "yrols", fetch: m.fetch });
  assert.equal(m.calls[0]!.headers["Content-Profile"], "yrols");
  assert.equal(m.calls[0]!.headers["Accept-Profile"], "yrols");
});

test("push verso Supabase: errore leggibile", async () => {
  const m = mockFetch(() => ({ status: 401, body: { message: "Invalid API key" } }));
  await assert.rejects(pushToSupabase(payload, { url: "https://x.supabase.co", serviceKey: "k", fetch: m.fetch }), /Supabase fallito \(401\)/);
});

test("stato da secret EB_STATE: esporta solo le connessioni", async () => {
  const conn = { id: "s1", bankName: "B", country: "IT", validUntil: "2099-01-01", status: "active" as const, createdAt: "x", accounts: [{ id: "a" }] };
  const store = new JsonStateStore(JSON.stringify({ connections: [conn], pending: [{ state: "p" }] }));
  const data = await store.load();
  assert.equal(data.pending.length, 0);
  assert.deepEqual(JSON.parse(exportState(data)), { connections: [conn] });
});

test("config: Supabase ha precedenza e EB_STATE viene letto", () => {
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const cfg = loadConfig({
    ENABLE_BANKING_APP_ID: "app",
    ENABLE_BANKING_PRIVATE_KEY: pem,
    SUPABASE_URL: "https://x.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "k",
    YROLS_URL: "http://y",
    YROLS_INGEST_TOKEN: "t",
    EB_STATE: "{}",
  });
  assert.equal(typeof cfg.push, "function");
  assert.equal(cfg.pushTarget, "Supabase (x.supabase.co, yrols.yrols_bank_sync)");
  assert.equal(cfg.stateJson, "{}");
});

test("SupabaseStore: connessioni dal database, uid corrente separato dall'id storico", async () => {
  const { SupabaseStore } = await import("../src/supabase.js");
  const m = mockFetch((c) => {
    if (c.url.pathname.endsWith("/bank_connections"))
      return { body: [{ id: "s2", bank_name: "Revolut", country: "IT", valid_until: "2099-01-01T00:00:00Z", status: "active" }] };
    if (c.url.pathname.endsWith("/bank_accounts"))
      return { body: [
        { id: "old-uid", connection_id: "s2", bank_name: "Revolut", name: "Conto", iban: "IT00", currency: "EUR", eb_uid: "new-uid" },
        { id: "x", connection_id: "altro", bank_name: "B", name: null, iban: null, currency: "EUR", eb_uid: null },
      ] };
    return undefined;
  });
  const store = new SupabaseStore({ url: "https://x.supabase.co", serviceKey: "k", schema: "yrols", fetch: m.fetch });
  const data = await store.load();
  assert.equal(m.calls[0]!.headers["Accept-Profile"], "yrols");
  assert.match(m.calls[0]!.url.search, /status=neq.revoked/);
  assert.equal(data.connections.length, 1);
  assert.deepEqual(data.connections[0]!.accounts, [
    { id: "old-uid", connectionId: "s2", iban: "IT00", name: "Conto", currency: "EUR", bankName: "Revolut", ebUid: "new-uid" },
  ]);
});

test("sync: chiama Enable Banking con l'uid corrente ma invia l'id storico", async () => {
  const { BankingService } = await import("../src/service.js");
  const { EnableBankingClient } = await import("../src/client.js");
  const { MemoryStore } = await import("../src/store.js");
  const eb = mockFetch((c) => {
    if (c.url.pathname === "/accounts/new-uid/balances")
      return { body: { balances: [{ balance_amount: { currency: "EUR", amount: "5" }, balance_type: "ITAV" }] } };
    if (c.url.pathname === "/accounts/new-uid/transactions") return { body: { transactions: [] } };
    return undefined;
  });
  const store = new MemoryStore();
  await store.save({ pending: [], connections: [{ id: "s2", bankName: "Revolut", country: "IT", validUntil: "2099-01-01", status: "active", createdAt: "", accounts: [{ id: "old-uid", ebUid: "new-uid" }] }] });
  const svc = new BankingService({ client: new EnableBankingClient({ applicationId: "a", privateKey, baseUrl: "https://api.test", fetch: eb.fetch }), store, redirectUrl: "x" });
  const { payload, errors } = await svc.buildSyncPayload();
  assert.equal(errors.length, 0);
  assert.deepEqual(payload.accounts, [{ id: "old-uid" }]);
  assert.equal(payload.balances![0]!.accountId, "old-uid");
});

test("config: con Supabase le connessioni arrivano dal database se EB_STATE manca", () => {
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const base = { ENABLE_BANKING_APP_ID: "app", ENABLE_BANKING_PRIVATE_KEY: pem, SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" };
  assert.deepEqual(loadConfig(base).supabaseStore, { url: "https://x.supabase.co", serviceKey: "k", schema: "yrols" });
  assert.equal(loadConfig({ ...base, CONNECTIONS_SOURCE: "file" }).supabaseStore, undefined);
});
