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
