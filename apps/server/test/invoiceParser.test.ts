import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInvoice, looksLikeInvoice, toIsoDate } from "../src/invoiceParser.ts";
import { linesFromItems } from "../src/pdfText.ts";

// Testo con la stessa impaginazione di un conto Fastweb (dati personali inventati).
const FASTWEB = `FASTWEB S.p.A.   Sede Legale e Amministrativa:   Cap. Sociale: € 41.344.209,40 i.v.
MARIO ROSSI
Abbonamenti anticipati
29/10/2026 - 30/11/2026   €   34,95
Codice Fiscale   Consumi effettuati nel periodo
RSSMRA80A01H501U   01/10/2026 - 31/10/2026   €   0,00
Codice Cliente   Altri costi   €   7,24
Codice di Migrazione   Totale da Pagare   € 42,19
Data di Scadenza   25 Nov 2026
Fattura N.   Emessa il
i tuoi consumi e accedere in modo semplice al
M000111222   01 Nov 2026
Periodo di fatturazione   a FastwebUP, il programma gratuito dedicato ai
dal 01 Ott 2026 al 31 Ott 2026   Clienti Fastweb.
Data Prossima Fattura
01 Dic 2026
Codice Cliente: 12345678
Fattura N. M000111222
RIEPILOGO COSTI
Importi per Abbonamenti   Importo (IVA inclusa)   Aliquota IVA
Fastweb Casa Full   € 33,95   22%
Contributo Attivazione rateizzato in 24 mesi   € 1,00   22%
Totale Importi per Abbonamenti   € 34,95
Accredito per Fastweb Casa Light dal 29/10/2026 al 31/10/2026   € -2,71   22%
Ricarica automatica Fastweb Mobile Start   € 9,95   0%
Totale Importi Altri costi   € 7,24
TOTALE DA PAGARE   € 42,19
Codice IVA   Aliquota IVA   Imponibile   IVA
21   0%   9,95   0,00`;

test("fattura Fastweb: tutti i campi", () => {
  const inv = parseInvoice(FASTWEB);
  assert.deepEqual({ ...inv, items: undefined }, {
    provider: "Fastweb", kind: "internet", invoiceNumber: "M000111222", issueDate: "2026-11-01", dueDate: "2026-11-25",
    periodFrom: "2026-10-01", periodTo: "2026-10-31", amount: 42.19, items: undefined,
  });
  assert.deepEqual(inv.items.map((i) => [i.amount, i.vat]), [[33.95, 22], [1, 22], [-2.71, 22], [9.95, 0]]);
  assert.equal(Math.round(inv.items.reduce((s, i) => s + i.amount, 0) * 100) / 100, 42.19, "le voci tornano col totale");
  assert.ok(looksLikeInvoice(inv));
});

test("fattura generica con date numeriche", () => {
  const inv = parseInvoice(`A2A Energia S.p.A.\nBolletta n. 2026/000123 del 05/11/2026\nPeriodo di riferimento: 01/09/2026 - 31/10/2026\nImporto da pagare 1.045,20 €\nDa pagare entro il 03/12/2026`);
  assert.equal(inv.provider, "A2A");
  assert.equal(inv.amount, 1045.2);
  assert.equal(inv.dueDate, "2026-12-03");
  assert.deepEqual([inv.periodFrom, inv.periodTo], ["2026-09-01", "2026-10-31"]);
});

test("non è una fattura", () => {
  assert.equal(looksLikeInvoice(parseInvoice("Volantino offerte di novembre: sconti fino al 50%")), false);
});

test("date italiane", () => {
  assert.equal(toIsoDate("5 dicembre 2026"), "2026-12-05");
  assert.equal(toIsoDate("01 Ott 2026"), "2026-10-01");
  assert.equal(toIsoDate("31/02/2026"), null);
});

test("righe del PDF ricostruite dalle posizioni", () => {
  const it = (s: string, x: number, y: number, width = s.length * 5) => ({ str: s, transform: [1, 0, 0, 1, x, y], width });
  assert.deepEqual(linesFromItems([it("€ 42,19", 300, 700), it("Totale da Pagare", 100, 701), it("Data di Scadenza", 100, 680), it("25 Nov 2026", 300, 680)]),
    ["Totale da Pagare   € 42,19", "Data di Scadenza   25 Nov 2026"]);
});
