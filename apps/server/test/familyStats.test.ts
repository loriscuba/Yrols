import { test } from "node:test";
import assert from "node:assert/strict";
import { computeFamily, familyCategory } from "../src/familyStats.ts";
import { computeTrips, type Trip, type TripTx } from "../src/tripStats.ts";

// Movimenti inventati: conto personale B e conto cointestato C.
const accounts = [{ id: "B", name: "Mario Rossi" }, { id: "C", name: "MARIO ROSSI & ANNA BIANCHI" }];
let n = 0;
const tx = (accountId: string, bookingDate: string, amount: number, description: string, counterparty: string | null = description): TripTx =>
  ({ id: `f${++n}`, accountId, bookingDate, amount, description, counterparty });

const old = tx("C", "2025-01-10", -50, "Conad");
const shop1 = tx("C", "2026-03-02", -40, "Conad Superstore");
const shop2 = tx("C", "2026-04-05", -60, "Lidl Italia");
const bread = tx("C", "2026-04-06", -3.5, "Forno Bianco");
const pizza = tx("C", "2026-04-07", -30, "Pizzeria Da Gino");
const amz1 = tx("C", "2026-04-08", -20, "Amazon", "Amazon* 12ab");
const amz2 = tx("C", "2026-04-09", -15, "www.amazon.it", "Www.amazon.* 34cd");
const amzRefund = tx("C", "2026-04-10", 15, "Refund from Amazon", "Amazon");
const deliveroo = tx("C", "2026-04-11", -25, "Deliveroo");
const iliad = tx("C", "2026-04-12", -9.99, "Iliad Italia");
const tickets = tx("C", "2026-04-12", -50, "Eventim / Ticketone");
const toMario = tx("C", "2026-04-13", -100, "To MARIO ROSSI", "Mario Rossi");
const fromMario = tx("B", "2026-04-13", 100, "From MARIO ROSSI & ANNA BIANCHI", "MARIO ROSSI & ANNA BIANCHI");
const salary = tx("C", "2026-04-14", 500, "Payment from Ditta Srl", "Ditta Srl");
const friend = tx("C", "2026-04-15", -20, "To Luca Verdi", "Luca Verdi");
const mystery = tx("C", "2026-04-16", -12, "Bottega XY");
const holiday = tx("C", "2026-04-21", -80, "Ristorante Mare Blu");
const other = tx("B", "2026-04-16", -99, "Conad");
const txs = [old, shop1, shop2, bread, pizza, amz1, amz2, amzRefund, deliveroo, iliad, tickets, toMario, fromMario, salary, friend, mystery, holiday, other];

const trip: Trip = { id: 1, title: "Mare", config: { country: "GR", from: "2026-04-20", to: "2026-04-22", keywords: [] } };
const trips = computeTrips([trip], txs, accounts, "2026-04-30");

test("categorie di tutti i giorni", () => {
  assert.equal(familyCategory(shop1), "spesa");
  assert.equal(familyCategory(bread), "panetteria");
  assert.equal(familyCategory(pizza), "ristoranti");
  assert.equal(familyCategory(amz2), "online");
  assert.equal(familyCategory(deliveroo), "delivery");
  assert.equal(familyCategory(iliad), "abbonamenti");
  assert.equal(familyCategory(tickets), "tempolibero"); // "eventim" non è TIM
  assert.equal(familyCategory(friend), "persone");
  assert.equal(familyCategory(mystery), "altro");
});

test("conta solo il conto scelto, senza giroconti, entrate e movimenti troppo vecchi", () => {
  const r = computeFamily({ accountId: "C", months: 12 }, txs, accounts, trips, "2026-04-30");
  const ids = new Set(r.lines.map((l) => l.id));
  for (const t of [old, other, toMario, salary]) assert.ok(!ids.has(t.id), t.description ?? "");
  assert.ok(ids.has(amzRefund.id)); // un rimborso abbassa la spesa
  assert.equal(r.from, "2025-04-30"); // un anno indietro
  // Se i dati della banca partono dopo, il periodo parte dal primo movimento.
  assert.equal(computeFamily({ accountId: "C" }, txs.filter((t) => t !== old), accounts, trips, "2026-04-30").from, "2026-03-02");
  assert.equal(r.lines.find((l) => l.id === holiday.id)?.category, "viaggi");
  assert.equal(r.total, 40 + 60 + 3.5 + 30 + 20 + 15 - 15 + 25 + 9.99 + 50 + 20 + 12 + 80);
  assert.equal(r.byMonth.length, 13);
  assert.equal(r.byMonth.find((m) => m.month === "2026-03")?.spesa, 40);
  const amazon = r.topMerchants.find((m) => m.merchant === "Amazon");
  assert.equal(amazon?.count, 3);
  assert.equal(amazon?.total, 20);
  assert.ok(!r.topMerchants.some((m) => m.merchant.includes("Mare Blu"))); // le vacanze hanno la loro statistica
});

test("schede, esclusioni e periodo", () => {
  const cfg = { accountId: "C", months: 1, places: { "bottega xy": { c: "casa" as const, d: "Ferramenta sotto casa" } }, exclude: [pizza.id] };
  const r = computeFamily(cfg, txs, accounts, trips, "2026-04-30");
  const m = r.lines.find((l) => l.id === mystery.id)!;
  assert.equal(m.category, "casa");
  assert.equal(m.info, "Ferramenta sotto casa");
  assert.ok(r.lines.find((l) => l.id === pizza.id)!.excluded);
  assert.ok(!r.byCategory.some((c) => c.category === "ristoranti"));
  assert.ok(!r.lines.some((l) => l.id === shop1.id)); // fuori dall'ultimo mese
});
