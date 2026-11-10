import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { openDb } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import { nextDate } from "../src/household.ts";
import { storeSuggestion } from "../src/email.ts";

async function start(opts = {}) {
  const db = openDb(":memory:");
  const server = createApp(db, { ingestToken: "segreto", ...opts }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { db, call, close: () => server.close() };
}

const auth = { authorization: "Bearer segreto" };
const today = new Date().toISOString().slice(0, 10);

test("sync bancaria: token, validazione e upsert", async () => {
  const { call, close } = await start();
  try {
    assert.equal((await call("POST", "/api/banks/sync", {})).status, 401);
    assert.equal((await call("POST", "/api/banks/sync", {}, { authorization: "Bearer sbagliato" })).status, 401);
    const bad = await call("POST", "/api/banks/sync", { transactions: [{ id: "t", accountId: "a", amount: "10", bookingDate: today }] }, auth);
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /amount/);

    const payload = {
      source: "enablebanking", syncedAt: new Date().toISOString(),
      connections: [{ id: "s1", bankName: "Banca Test", country: "IT", validUntil: today, status: "active" }],
      accounts: [{ id: "a1", name: "Conto", bankName: "Banca Test", iban: "IT00", currency: "EUR", connectionId: "s1" }],
      balances: [{ accountId: "a1", amount: 1000, type: "CLBD", date: today }, { accountId: "a1", amount: 990, type: "ITAV", date: today }],
      transactions: [{ id: "t1", accountId: "a1", amount: -10.5, currency: "EUR", bookingDate: today, description: "Caffè" }],
    };
    const ok = await call("POST", "/api/banks/sync", payload, auth);
    assert.deepEqual(ok.body, { ok: true, connections: 1, accounts: 1, balances: 2, transactions: 1 });
    // Seconda sync identica: nessun duplicato
    await call("POST", "/api/banks/sync", payload, auth);
    const accounts = (await call("GET", "/api/banks/accounts")).body;
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].balance, 990, "ITAV preferito su CLBD");
    assert.equal((await call("GET", "/api/banks/transactions")).body.length, 1);

    const ov = (await call("GET", "/api/overview")).body;
    assert.equal(ov.netWorth, 990);
    assert.equal(ov.last30.expenses, 10.5);
    assert.ok(ov.agenda.some((a: any) => a.type === "consent"), "consenso in scadenza in agenda");
    await call("POST", "/api/banks/sync", { connections: [{ id: "s2", bankName: "Abbandonata", validUntil: today }] }, auth);
    const ov2 = (await call("GET", "/api/overview")).body;
    assert.equal(ov2.agenda.filter((a: any) => a.type === "consent").length, 1, "banca senza conti esclusa");
  } finally { close(); }
});

test("sync disattivata senza token", async () => {
  const { call, close } = await start({ ingestToken: undefined });
  try { assert.equal((await call("POST", "/api/banks/sync", {}, auth)).status, 503); } finally { close(); }
});

test("bollette: crud e pagamento riconosciuto dal movimento bancario", async () => {
  const { call, close } = await start();
  try {
    assert.equal((await call("POST", "/api/bills", { provider: "Enel" })).status, 400);
    const bill = (await call("POST", "/api/bills", { provider: "Enel Energia", kind: "luce", amount: "82,10", dueDate: today })).body;
    assert.equal(bill.amount, 82.1);
    assert.equal(bill.paidAt, null);
    await call("POST", "/api/banks/sync", { transactions: [{ id: "x", accountId: "a1", amount: -82.1, bookingDate: today, description: "SDD ENEL ENERGIA SPA" }] }, auth);
    const after = (await call("GET", "/api/bills")).body[0];
    assert.equal(after.paidAt, today);
    assert.equal((await call("DELETE", `/api/bills/${bill.id}`)).status, 204);
  } finally { close(); }
});

test("scadenze ricorrenti generano la successiva", async () => {
  const { call, close } = await start();
  try {
    const d = (await call("POST", "/api/deadlines", { title: "Bollo auto", category: "auto", dueDate: "2026-01-31", recurrence: "yearly" })).body;
    const done = (await call("PATCH", `/api/deadlines/${d.id}`, { doneAt: today })).body;
    assert.equal(done.next.dueDate, "2027-01-31");
    assert.equal((await call("GET", "/api/deadlines")).body.length, 2);
    assert.equal(nextDate("2026-01-31", "monthly"), "2026-02-28");
    assert.equal(nextDate("2026-11-15", "quarterly"), "2027-02-15");
  } finally { close(); }
});

test("promemoria e basic auth", async () => {
  const { call, close } = await start({ basicAuth: { user: "loris", password: "pw" } });
  try {
    assert.equal((await call("GET", "/api/reminders")).status, 401);
    const h = { authorization: "Basic " + Buffer.from("loris:pw").toString("base64") };
    assert.equal((await call("POST", "/api/reminders", { text: "Chiamare idraulico", priority: "alta" }, h)).status, 201);
    assert.equal((await call("GET", "/api/reminders", undefined, h)).body.length, 1);
    // la sync usa il proprio token anche con basic auth attiva
    assert.equal((await call("POST", "/api/banks/sync", {}, auth)).status, 200);
  } finally { close(); }
});

test("suggerimenti da email: conferma crea la bolletta", async () => {
  const { db, call, close } = await start();
  try {
    assert.ok(storeSuggestion(db, "<m1@x>", { from: "Enel Energia <noreply@enel.it>", subject: "La tua bolletta è disponibile",
      text: "Importo da pagare: € 64,30. Scadenza: 15/11/2026." }));
    assert.ok(!storeSuggestion(db, "<m1@x>", { from: "Enel Energia <noreply@enel.it>", subject: "La tua bolletta è disponibile", text: "Importo € 64,30 scadenza 15/11/2026" }), "nessun duplicato");
    const [s] = (await call("GET", "/api/email/suggestions")).body;
    assert.equal(s.amount, 64.3);
    assert.equal(s.dueDate, "2026-11-15");
    const bill = await call("POST", `/api/email/suggestions/${s.id}/accept`, {});
    assert.equal(bill.status, 201);
    assert.equal(bill.body.provider, "Enel Energia");
    assert.equal((await call("POST", `/api/email/suggestions/${s.id}/accept`, {})).status, 409);
    assert.equal((await call("POST", "/api/email/scan")).status, 503);
  } finally { close(); }
});
