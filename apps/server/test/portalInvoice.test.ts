import { test } from "node:test";
import assert from "node:assert/strict";
import { portalInvoice } from "../src/portalInvoice.ts";

// Dati inventati, impaginazione simile a una fattura Fastweb.
const FULL = `FASTWEB S.p.A.
Totale da Pagare   € 42,19
Data di Scadenza   25 Nov 2026
Fattura N. M000111222   Emessa il 01 Nov 2026
Fastweb Casa Full   € 33,95   22%`;

test("bolletta completa dall'area clienti: si salva subito", () => {
  const r = portalInvoice(FULL, "Fastweb");
  assert.equal(r.result, "bill");
  if (r.result !== "bill") return;
  assert.equal(r.bill.provider, "Fastweb");
  assert.equal(r.bill.amount, 42.19);
  assert.equal(r.bill.dueDate, "2026-11-25");
  assert.equal(r.bill.invoiceNumber, "M000111222");
});

test("senza scadenza: diventa una proposta da completare, col fornitore dichiarato", () => {
  const r = portalInvoice("Fattura n. IL-2026-0001\nTotale fattura € 9,99\nIliad Italia S.p.A.", "Iliad");
  assert.equal(r.result, "suggestion");
  if (r.result !== "suggestion") return;
  assert.equal(r.bill.provider, "Iliad");
  assert.equal(r.bill.kind, "telefono");
  assert.equal(r.bill.dueDate, null);
});

test("un PDF che non è una fattura non entra", () => {
  assert.deepEqual(portalInvoice("Condizioni generali di contratto\nArticolo 1", "Sorgenia"), { result: "unreadable" });
});
