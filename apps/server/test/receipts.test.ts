import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJson, normalizeReading, pricesForPrompt, savings, READING_SCHEMA } from "../../../supabase/functions/_shared/receipts.ts";

// Scontrino inventato: i test non usano mai scontrini reali (il repo è pubblico).
const raw = {
  store: "  Alimentari Rossi srl ", storeVat: "01234567890", storeAddress: "via Roma 1, Savona", chain: null,
  date: "2026-11-02", time: "09:15", total: 10.5, electronicPayment: true,
  items: [
    { description: "BANANE", product: "Banane", category: "frutta e verdura", amount: 2.5,
      alternatives: [{ store: "Lidl", price: 1.9, detail: "al kg" }, { store: "Coop", price: 2.8, detail: null }, { store: "Gratis", price: 0, detail: null }] },
    { description: "DETERSIVO", product: "Detersivo piatti", category: "inventata", amount: 3,
      alternatives: [{ store: "Coop", price: 2.2, detail: "marca Coop" }] },
    { description: "BUONO", product: "Sconto", category: "altro", amount: -0.5, alternatives: [{ store: "Lidl", price: 1, detail: null }] },
    { description: "PANE", product: "Pane", category: "dispensa", amount: 5.5, alternatives: [] },
    { description: "", amount: 1 },
  ],
  tips: ["Compra la frutta al Lidl", 3, ""],
  summary: "Potevi risparmiare poco.",
};

test("normalizeReading: pulisce tipi, categorie e alternative non valide", () => {
  const r = normalizeReading(raw);
  assert.equal(r.store, "Alimentari Rossi srl");
  assert.equal(r.date, "2026-11-02");
  assert.equal(r.items.length, 4, "la riga senza descrizione è scartata");
  assert.deepEqual(r.items[0].alternatives.map((a) => a.store), ["Lidl", "Coop"], "niente prezzi a zero");
  assert.equal(r.items[1].category, "altro");
  assert.deepEqual(r.items[2].alternatives, [], "gli sconti non hanno alternative");
  assert.deepEqual(r.tips, ["Compra la frutta al Lidl"]);
  assert.equal(normalizeReading({ date: "2026-13-45", time: "25:00", total: -3 }).date, null);
  assert.equal(normalizeReading({ time: "25:00" }).time, null);
  assert.equal(normalizeReading({ total: -3 }).total, null);
  assert.deepEqual(normalizeReading(null).items, []);
});

test("savings: prodotto per prodotto e spesa intera per catena", () => {
  const s = savings(normalizeReading(raw).items);
  assert.equal(s.paid, 10.5);
  assert.deepEqual(s.cheaper.map((c) => [c.product, c.store, c.saving]), [["Detersivo piatti", "Coop", 0.8], ["Banane", "Lidl", 0.6]]);
  assert.equal(s.bestMix, 1.4);
  // Coop: banane 2,80 (più care) + detersivo 2,20 + il resto al prezzo pagato.
  assert.deepEqual(s.stores, [
    { store: "Lidl", total: 9.9, saving: 0.6, covered: 1 },
    { store: "Coop", total: 10, saving: 0.5, covered: 2 },
  ]);
});

test("listino per Claude e schema della risposta", () => {
  assert.equal(pricesForPrompt([]), "(listino vuoto)");
  assert.equal(pricesForPrompt([{ store: "Lidl", product: "Banane", detail: null, price: 1.49, unit: "kg", unit_price: 1.49, checked_on: "2026-11-16" }]),
    "Lidl | Banane |  | 1.49 € | 1.49 €/kg | rilevato 2026-11-16");
  assert.deepEqual([...READING_SCHEMA.required].sort(), Object.keys(READING_SCHEMA.properties).sort());
});

test("extractJson: risposta con blocco di codice o testo intorno", () => {
  assert.deepEqual(extractJson('```json\n{"total": 4.2}\n```'), { total: 4.2 });
  assert.deepEqual(extractJson('Ecco: {"a": {"b": 1}} fine'), { a: { b: 1 } });
  assert.throws(() => extractJson("niente"));
});
