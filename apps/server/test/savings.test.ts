import { test } from "node:test";
import assert from "node:assert/strict";
import { currentSpend, guessCategory, summarize, type SavingOffer } from "../src/savings.ts";

const offer = (o: Partial<SavingOffer>): SavingOffer => ({
  id: 1, category: "luce", provider: "Octopus Energy", name: "Flex", priceType: "variabile", monthlyCost: 40, currentMonthly: null,
  currentProvider: null, priceDetails: null, conditions: null, url: null, source: "Selectra", validUntil: null, status: "nuova",
  active: true, firstSeen: "2026-11-14", lastSeen: "2026-11-14", ...o,
});

test("riconosce la voce dal nome del fornitore", () => {
  assert.equal(guessCategory("FASTWEB SpA Addebito SDD"), "internet");
  assert.equal(guessCategory("Iliad Italia"), "telefono");
  assert.equal(guessCategory("Sorgenia S.p.A. Addebito SDD"), "energia");
  assert.equal(guessCategory("Amazon Prime"), "abbonamenti");
  assert.equal(guessCategory("Condominio Via Roma"), null);
});

test("spesa attuale: prima il controllo, poi i fornitori, poi i movimenti", () => {
  const rec = [{ label: "FASTWEB SpA", monthly: 37.9 }, { label: "Sorgenia S.p.A.", monthly: 103.67 }, { label: "Amazon Prime", monthly: 4.99 }];
  const offers = [offer({ currentMonthly: 52.1, currentProvider: "Sorgenia" })];
  assert.deepEqual(currentSpend(offers, null, rec), [
    { category: "luce", provider: "Sorgenia", monthly: 52.1, from: "controllo" },
    { category: "internet", provider: "FASTWEB SpA", monthly: 37.9, from: "movimenti" },
    { category: "abbonamenti", provider: "Amazon Prime", monthly: 4.99, from: "movimenti" },
  ]);
  // Con l'anagrafica fornitori i movimenti non si contano due volte; i fornitori nascosti si ignorano.
  const sup = [{ name: "Fastweb", kind: "internet", monthly: 37.9 }, { name: "Iliad", kind: "telefono", monthly: 9.99, status: "nascosto" }];
  assert.deepEqual(currentSpend([], sup, rec).map((c) => [c.category, c.provider, c.from]), [
    ["internet", "Fastweb", "fornitori"], ["abbonamenti", "Amazon Prime", "movimenti"],
  ]);
});

test("riepilogo: offerte dalla più economica, risparmio e offerte nascoste", () => {
  const offers = [
    offer({ id: 1, monthlyCost: 45, currentMonthly: 50 }),
    offer({ id: 2, provider: "Edison", monthlyCost: 38, currentMonthly: 50, status: "nascosta" }),
    offer({ id: 3, provider: "Vecchia", monthlyCost: 10, active: false }),
    offer({ id: 4, category: "internet", provider: "Iliad", monthlyCost: 44 }),
  ];
  const cur = currentSpend(offers, null, [{ label: "Fastweb", monthly: 37.9 }]);
  const [luce, internet] = summarize(offers, cur);
  assert.deepEqual(luce.offers.map((o) => [o.id, o.saving]), [[1, 5]]);
  assert.equal(luce.monthlySaving, 5);
  assert.equal(internet.monthlySaving, 0, "un'offerta più cara non è un risparmio");
  assert.deepEqual(internet.offers[0].saving, -6.1);
  assert.deepEqual(summarize(offers, cur, true)[0].offers.map((o) => o.id), [2, 1]);
});
