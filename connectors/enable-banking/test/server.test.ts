import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { EnableBankingClient } from "../src/client.js";
import { BankingService } from "../src/service.js";
import { MemoryStore } from "../src/store.js";
import { createApp } from "../src/server.js";
import { fakeEnableBanking, privateKey } from "./helpers.js";

test("API HTTP: token, consenso, callback, conti, sync", async (t) => {
  const eb = fakeEnableBanking();
  const client = new EnableBankingClient({ applicationId: "app", privateKey, baseUrl: "https://api.test", fetch: eb.fetch });
  const service = new BankingService({ client, store: new MemoryStore(), redirectUrl: "http://x/cb" });
  const server = createApp({ service, apiToken: "segreto", dashboardUrl: "http://dash.test/banche", log: () => {} });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = { Authorization: "Bearer segreto", "Content-Type": "application/json" };

  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/api/banks/accounts`)).status, 401);

  const c = await fetch(`${base}/api/banks/connect`, { method: "POST", headers: auth, body: JSON.stringify({ bankName: "Banca Test" }) });
  assert.equal(c.status, 200);
  assert.equal((await c.json()).url, "https://bank.example/consent?x=1");
  const state = (eb.calls.find((x) => x.url.pathname === "/auth")!.body as { state: string }).state;

  const cb = await fetch(`${base}/api/banks/callback?code=abc&state=${state}`, { redirect: "manual" });
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get("location"), "http://dash.test/banche?bank=connected&connection=sess-1");

  const bad = await fetch(`${base}/api/banks/callback?code=abc&state=nope`, { redirect: "manual" });
  assert.match(bad.headers.get("location")!, /bank=error/);

  const acc = await (await fetch(`${base}/api/banks/accounts`, { headers: auth })).json();
  assert.equal(acc.accounts[0].id, "acc-1");

  const bal = await (await fetch(`${base}/api/banks/accounts/acc-1/balances`, { headers: auth })).json();
  assert.equal(bal.balances.length, 2);

  assert.equal((await fetch(`${base}/api/banks/accounts/sconosciuto/balances`, { headers: auth })).status, 404);

  const s = await (await fetch(`${base}/api/banks/sync`, { method: "POST", headers: auth })).json();
  assert.deepEqual(s.counts, { connections: 1, accounts: 1, balances: 2, transactions: 2 });
  assert.equal(s.payload.source, "enablebanking");
});
