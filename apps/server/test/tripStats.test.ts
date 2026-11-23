import { test } from "node:test";
import assert from "node:assert/strict";
import { cardCountry, categorize, computeTrips, internalIds, merchantName, operationDate, type Trip, type TripTx } from "../src/tripStats.ts";

// Movimenti inventati: conto principale A (banca con carta), carta B, conto cointestato C.
const accounts = [{ id: "A", name: "ROSSI MARIO" }, { id: "B", name: "Mario Rossi" }, { id: "C", name: "MARIO ROSSI & ANNA BIANCHI" }];
let n = 0;
const tx = (accountId: string, bookingDate: string, amount: number, description: string, counterparty: string | null = null): TripTx =>
  ({ id: `t${++n}`, accountId, bookingDate, amount, description, counterparty });

const flight = tx("B", "2026-03-01", -600, "Sky Airlines", "Sky Airlines");
const esim = tx("B", "2026-04-09", -20, "Holafly", "Holafly");
const sushi = tx("B", "2026-04-10", -40, "Sushi Bar Ginza", "Sushi Bar Ginza");
const hotel = tx("B", "2026-04-11", -300, "Hotel Sakura", "Hotel Sakura");
const konbini = tx("B", "2026-04-11", -5, "Seven-Eleven", "Seven-Eleven");
const cash = tx("B", "2026-04-12", -100, "Cash at Lawson Asakusa");
const refund = tx("B", "2026-04-13", 10, "Refund from Hotel Sakura");
const cardLate = tx("A", "2026-04-17", -50, "KYOTO SHOP KYOTO JP Carta N. ***** 123 Data operazione 14/04/26");
const vault = tx("B", "2026-04-12", -50, "To EUR Emergenze");
const vaultBack = tx("B", "2026-04-12", 50, "From Conto Deposito Vacanze");
const toJoint = tx("B", "2026-04-12", -200, "Soldi viaggio To MARIO ROSSI & ANNA BIANCHI", "MARIO ROSSI & ANNA BIANCHI");
const jointIn = tx("C", "2026-04-12", 200, "Soldi viaggio From Mario R", "Mario R");
const topup = tx("A", "2026-04-10", -300, "Revolut**1234* Dublin IE Carta N. ***** 123 Data operazione 08/04/26");
const gift = tx("B", "2026-04-12", 80, "Regalo di viaggio Payment from Zio");
const home = tx("A", "2026-04-20", -30, "SUPERMERCATO CENTRO MILANO IT Carta N. ***** 123 Data operazione 19/04/26");
const esim2 = tx("B", "2026-06-01", -15, "Holafly", "Holafly");
const istanbul = tx("B", "2026-06-03", -25, "Galata Kahve", "Galata Kahve");
const txs = [flight, esim, sushi, hotel, konbini, cash, refund, cardLate, vault, vaultBack, toJoint, jointIn, topup, gift, home, esim2, istanbul];

const japan: Trip = { id: 1, title: "Giappone", config: { country: "JP", from: "2026-04-10", to: "2026-04-15", keywords: ["Sky Airlines", "Holafly"] } };
const turkey: Trip = { id: 2, title: "Turchia", config: { country: "TR", from: "2026-06-02", to: null, keywords: ["Holafly"] } };

test("data operazione e paese delle carte", () => {
  assert.equal(operationDate(cardLate), "2026-04-14");
  assert.equal(operationDate(sushi), "2026-04-10");
  assert.equal(cardCountry(cardLate), "JP");
  assert.equal(cardCountry(sushi), null);
  assert.equal(merchantName(cardLate), "Kyoto Shop Kyoto");
});

test("categorie", () => {
  assert.equal(categorize(hotel), "alloggio");
  assert.equal(categorize(flight), "trasporti");
  assert.equal(categorize(sushi), "ristoranti");
  assert.equal(categorize(konbini), "spesa");
  assert.equal(categorize(cash), "contanti");
  assert.equal(categorize({ description: "Go(taxi App)", counterparty: null }), "trasporti");
});

test("giroconti, salvadanai e ricariche non sono spesa", () => {
  const ids = internalIds(txs, accounts);
  for (const t of [vault, vaultBack, toJoint, jointIn, topup]) assert.ok(ids.has(t.id), t.description!);
  for (const t of [sushi, hotel, cash, gift, flight]) assert.ok(!ids.has(t.id), t.description!);
});

test("spesa del viaggio: date, parole chiave, rimborsi, viaggio in corso", () => {
  const [jp, tr] = computeTrips([japan, turkey], txs, accounts, "2026-06-04");
  const ids = jp.lines.map((l) => l.id).sort();
  assert.deepEqual(ids, [flight, esim, sushi, hotel, konbini, cash, refund, cardLate].map((t) => t.id).sort());
  // 600 volo + 20 esim + 40 + 300 + 5 + 100 + 50 − 10 di rimborso
  assert.equal(jp.total, 1105);
  assert.equal(jp.before, 620, "volo ed eSIM pagati prima della partenza");
  assert.equal(jp.days, 6);
  assert.equal(jp.perDay, 80.83);
  assert.equal(jp.byCategory[0].category, "trasporti");
  assert.equal(jp.byDay.length, 6);
  assert.equal(jp.byDay.find((d) => d.date === "2026-04-14")!.total, 50);

  // La seconda eSIM va al viaggio che inizia più vicino; senza data di fine il viaggio arriva a oggi.
  assert.deepEqual(tr.lines.map((l) => l.id).sort(), [esim2.id, istanbul.id].sort());
  assert.equal(tr.to, "2026-06-04");
  assert.equal(tr.total, 40);
});

test("movimenti tolti o aggiunti a mano", () => {
  const trip: Trip = { ...japan, config: { ...japan.config, exclude: [cash.id], include: [home.id] } };
  const [jp] = computeTrips([trip], txs, accounts, "2026-06-04");
  assert.ok(jp.lines.find((l) => l.id === cash.id)!.excluded);
  assert.equal(jp.lines.find((l) => l.id === home.id)!.reason, "manual");
  assert.equal(jp.total, 1105 - 100 + 30);
});

test("acquisti online tolti in automatico, bonifici, schede degli esercenti e Maps", () => {
  const online = tx("B", "2026-04-12", -9.99, "www.amazon.it", "www.amazon.it");
  const split = tx("B", "2026-04-16", -120, "Split Giappone To Luca Verdi", "Luca Verdi");
  const shop = tx("B", "2026-04-13", -30, "Nippon Modern", "Nippon Modern");
  const trip: Trip = { ...japan, config: { ...japan.config, keywords: [...japan.config.keywords!, "Giappone"], places: { "nippon modern": { c: "attrazioni", d: "Museo d'arte", q: "Nippon Modern Museum Tokyo" } } } };
  const all = [...txs, online, split, shop];
  let [jp] = computeTrips([trip], all, accounts, "2026-06-04");
  const l = (t: TripTx) => jp.lines.find((x) => x.id === t.id)!;
  assert.ok(l(online).excluded && l(online).autoExcluded, "Amazon non è spesa del viaggio");
  assert.equal(l(split).category, "bonifici");
  assert.equal(l(split).mapsUrl, null);
  assert.equal(l(shop).category, "attrazioni");
  assert.equal(l(shop).info, "Museo d'arte");
  assert.equal(l(shop).mapsUrl, "https://www.google.com/maps/search/?api=1&query=Nippon%20Modern%20Museum%20Tokyo");
  assert.match(l(sushi).mapsUrl!, /query=Sushi%20Bar%20Ginza%20Giappone$/);
  assert.equal(jp.total, 1105 + 120 + 30);
  // Rimesso a mano: conta.
  [jp] = computeTrips([{ ...trip, config: { ...trip.config, include: [online.id] } }], all, accounts, "2026-06-04");
  assert.ok(!l(online).excluded);
});
