import { test } from "node:test";
import assert from "node:assert/strict";
import { EnableBankingClient } from "../src/client.js";
import { BankingService } from "../src/service.js";
import { MemoryStore } from "../src/store.js";
import { fakeEnableBanking, mockFetch, privateKey } from "./helpers.js";

function setup() {
  const eb = fakeEnableBanking();
  const client = new EnableBankingClient({ applicationId: "app", privateKey, baseUrl: "https://api.test", fetch: eb.fetch });
  const svc = new BankingService({
    client,
    store: new MemoryStore(),
    redirectUrl: "http://localhost:8787/api/banks/callback",
    now: () => new Date("2026-11-01T10:00:00Z"),
  });
  return { eb, svc };
}

test("flusso completo: consenso, conti, saldi, movimenti paginati, sync con push", async () => {
  const { eb, svc } = setup();
  const { url, state } = await svc.startConnection("Banca Test", "IT");
  assert.equal(url, "https://bank.example/consent?x=1");
  const auth = eb.calls.find((c) => c.url.pathname === "/auth")!;
  assert.match(auth.headers.Authorization!, /^Bearer ey/);
  assert.deepEqual((auth.body as { aspsp: unknown }).aspsp, { name: "Banca Test", country: "IT" });
  assert.equal((auth.body as { access: { valid_until: string } }).access.valid_until, "2027-01-30T10:00:00.000Z");

  await assert.rejects(svc.completeConnection("code", "stato-sbagliato"), /state non valido/);
  const conn = await svc.completeConnection("code", state);
  assert.equal(conn.id, "sess-1");
  await assert.rejects(svc.completeConnection("code", state), /state non valido/, "state monouso");

  const accounts = await svc.listAccounts();
  assert.deepEqual(accounts.map((a) => a.id), ["acc-1"]);
  assert.equal(accounts[0]!.bankName, "Banca Test");

  const txs = await svc.getTransactions("acc-1");
  assert.equal(txs.length, 2, "due pagine unite");
  assert.equal(eb.calls.filter((c) => c.url.pathname.endsWith("/transactions")).at(-1)!.url.searchParams.get("continuation_key"), "page2");

  const ingest = mockFetch(() => ({ body: { ok: true, connections: 1, accounts: 1, balances: 2, transactions: 2 } }));
  const r = await svc.sync({ yrolsUrl: "http://yrols.test/", ingestToken: "tok", fetch: ingest.fetch });
  assert.equal(r.errors.length, 0);
  assert.equal(r.pushed?.ok, true);
  const push = ingest.calls[0]!;
  assert.equal(push.url.toString(), "http://yrols.test/api/banks/sync");
  assert.equal(push.headers.Authorization, "Bearer tok");
  const body = push.body as Record<string, any>;
  assert.equal(body.source, "enablebanking");
  assert.deepEqual(body.connections, [{ id: "sess-1", bankName: "Banca Test", country: "IT", validUntil: "2099-01-01T00:00:00Z", status: "active" }]);
  assert.equal(body.balances.length, 2);
  assert.equal(body.transactions[0].amount, -82.1);
  assert.equal(body.transactions[1].amount, 1500);
  // Prima sync: 90 giorni di storico.
  const firstFrom = eb.calls.filter((c) => c.url.pathname.endsWith("/transactions")).at(-2)!.url.searchParams.get("date_from");
  assert.equal(firstFrom, "2026-08-03");

  // Seconda sync: incrementale da lastSyncAt - 7 giorni.
  await svc.sync();
  const lastFrom = eb.calls.filter((c) => c.url.pathname.endsWith("/transactions")).at(-2)!.url.searchParams.get("date_from");
  assert.equal(lastFrom, "2026-10-25");

  await svc.disconnect("sess-1");
  assert.equal((await svc.listConnections())[0]!.status, "revoked");
  assert.deepEqual(await svc.listAccounts(), []);
});

test("errore su un conto non blocca la sync", async () => {
  const { svc } = setup();
  const { state } = await svc.startConnection("Banca Test");
  await svc.completeConnection("code", state);
  // Client che fallisce sui saldi
  (svc.client as any).getBalances = async () => {
    throw new Error("ASPSP non disponibile");
  };
  const r = await svc.sync();
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0]!.step, "balances");
  assert.equal(r.payload.transactions!.length, 2);
});
