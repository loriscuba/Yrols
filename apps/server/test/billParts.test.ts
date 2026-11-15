import { test } from "node:test";
import assert from "node:assert/strict";
import { billParts, itemPart, latestSplits } from "../src/billParts.ts";

// Voci inventate, come quelle di un conto Fastweb con linea di casa e SIM.
const items = [
  { description: "Fastweb Casa Full", amount: 29.95, vat: 22 },
  { description: "Contributo Attivazione rateizzato in 24 mesi", amount: 1, vat: 22 },
  { description: "Accredito per Fastweb Casa Light dal 01/10/2026 al 03/10/2026", amount: -2.5, vat: 22 },
  { description: "Ricarica automatica Fastweb Mobile Start Num. 3330000000, dal 05/10/2026 al", amount: 8.95, vat: 0 },
];

test("riconosce a quale servizio va una voce", () => {
  assert.equal(itemPart("Fastweb Casa Full"), "internet");
  assert.equal(itemPart("Ricarica automatica Fastweb Mobile Start"), "telefono");
  assert.equal(itemPart("Contributo Attivazione rateizzato in 24 mesi"), null);
});

test("scorpora il conto in internet casa e telefonia mobile", () => {
  assert.deepEqual(billParts({ kind: "internet", items }), [
    { part: "internet", label: "Internet casa", amount: 28.45, monthly: 30.95 },
    { part: "telefono", label: "Telefonia mobile", amount: 8.95, monthly: 8.95 },
  ]);
  assert.deepEqual(billParts({ kind: "internet", items: items.slice(0, 3) }), [], "solo la linea di casa: niente da scorporare");
  assert.deepEqual(billParts({ kind: "luce", items }), [], "solo internet e telefonia");
});

test("per ogni fornitore usa l'ultima bolletta scorporabile", () => {
  const old = { provider: "Fastweb", kind: "internet", dueDate: "2026-10-25", items: [items[0]!, { ...items[3]!, amount: 5 }] };
  const now = { provider: "FASTWEB", kind: "internet", dueDate: "2026-11-25", items };
  const s = latestSplits([old, now]);
  assert.equal(s.size, 1);
  assert.equal(s.get("fastweb")!.parts[1]!.monthly, 8.95);
});
