import { test } from "node:test";
import assert from "node:assert/strict";
import { findRecurring, merchantKey, projectMonth, type RecTx } from "../src/recurring.ts";

// Movimenti inventati: due conti dello stesso titolare, dati dal 2 agosto al 14 novembre.
const accounts = [{ id: "A", name: "ROSSI MARIO" }, { id: "B", name: "Mario Rossi" }];
let n = 0;
const tx = (accountId: string, bookingDate: string, amount: number, description: string, counterparty: string | null = null): RecTx =>
  ({ id: `t${++n}`, accountId, bookingDate, amount, description, counterparty });

const txs: RecTx[] = [
  // Abbonamento fisso, sempre il 7.
  ...["2026-08-07", "2026-09-07", "2026-10-07", "2026-11-07"].map((d) => tx("A", d, -9.99, "Streaming Plus")),
  // Bolletta luce SDD a importo variabile, verso il 18, non ancora arrivata a novembre.
  tx("A", "2026-08-18", -61.2, "LUCE ITALIA S.p.A. Addebito SDD fattura a Vs carico da IT00X"),
  tx("A", "2026-09-19", -48.4, "LUCE ITALIA S.p.A. Addebito SDD fattura a Vs carico da IT00X"),
  tx("A", "2026-10-17", -55.0, "LUCE ITALIA S.p.A. Addebito SDD fattura a Vs carico da IT00X"),
  // Stesso condominio, due rate diverse al mese.
  ...["2026-08-13", "2026-09-13", "2026-10-13", "2026-11-13"].map((d) => tx("A", d, -100, "Quota mensile ordinaria", "CONDOMINIO VIA ROMA 1")),
  ...["2026-08-20", "2026-09-20", "2026-10-20"].map((d) => tx("A", d, -40, "Rata mensile straordinaria", "Condominio Via Roma")),
  // Spesa al supermercato: tante volte al mese, non è un pagamento ricorrente.
  ...["2026-08-03", "2026-08-09", "2026-08-21", "2026-09-04", "2026-09-12", "2026-09-28", "2026-10-02", "2026-10-15", "2026-10-30"]
    .map((d, i) => tx("A", d, -(20 + i * 3), "SUPERMERCATO CENTRO Carta N. ***** 123")),
  // Bar visto solo due mesi con importi diversi: non basta.
  tx("A", "2026-09-05", -4.5, "Bar Sport"), tx("A", "2026-10-05", -6, "Bar Sport"),
  // Giroconto mensile verso l'altro conto: non è spesa.
  ...["2026-08-01", "2026-09-01", "2026-10-01", "2026-11-01"].flatMap((d) => [tx("A", d, -500, "Bonifico a conto risparmio"), tx("B", d, 500, "Bonifico da conto principale")]),
  // Trasferimento a se stessi riconosciuto dal nome.
  ...["2026-08-25", "2026-09-25", "2026-10-25"].map((d) => tx("B", d, -50, "To MARIO ROSSI", "Mario Rossi")),
  // Stipendio: entrata, ignorata.
  ...["2026-08-27", "2026-09-27", "2026-10-27"].map((d) => tx("A", d, 2000, "Stipendio")),
];

const TODAY = "2026-11-14";

test("merchantKey ignora dettagli tecnici, numeri e forma societaria", () => {
  assert.equal(merchantKey({ description: "LUCE ITALIA S.p.A. Addebito SDD fattura 123", counterparty: null }), "luce italia");
  assert.equal(merchantKey({ description: "Quota mensile ordinaria", counterparty: "CONDOMINIO VIA ROMA 1" }), "condominio via roma|quota mensile");
});

test("riconosce i pagamenti ricorrenti e scarta spese occasionali e giroconti", () => {
  const rec = findRecurring(txs, accounts, TODAY);
  const labels = rec.map((r) => r.label).sort();
  assert.deepEqual(labels, ["Condominio Via Roma · Rata mensile straordinaria", "Condominio Via Roma 1 · Quota mensile ordinaria", "LUCE ITALIA S.p.A.", "Streaming Plus"].sort());
  const luce = rec.find((r) => r.label.startsWith("LUCE"))!;
  assert.equal(luce.directDebit, true);
  assert.equal(luce.variable, true);
  assert.equal(luce.monthly, 54.87);
  const tv = rec.find((r) => r.label === "Streaming Plus")!;
  assert.deepEqual([tv.monthly, tv.day, tv.variable, tv.perMonth], [9.99, 7, false, 1]);
});

test("proiezione del mese in corso: già addebitato e ancora da addebitare", () => {
  const rec = findRecurring(txs, accounts, TODAY);
  const p = projectMonth(rec, txs, "2026-11", TODAY);
  assert.equal(p.accounts.length, 1);
  const a = p.accounts[0];
  assert.equal(a.accountId, "A");
  assert.equal(a.paid, 109.99); // streaming + quota condominio
  assert.equal(a.remaining, 94.87); // luce prevista + rata straordinaria
  assert.equal(p.expected, 204.86);
  const luce = a.items.find((i) => i.label.startsWith("LUCE"))!;
  assert.equal(luce.nextDate, "2026-11-18");
  const rata = a.items.find((i) => i.label.includes("straordinaria"))!;
  assert.equal(rata.nextDate, "2026-11-20");
});

test("proiezione del mese prossimo e bollette dal calendario senza doppioni", () => {
  const rec = findRecurring(txs, accounts, TODAY);
  const planned = [
    { id: "b1", label: "Luce Italia", amount: 58, dueDate: "2026-12-18", source: "bill" as const },
    { id: "d1", label: "Assicurazione auto", amount: 320, dueDate: "2026-12-05", source: "deadline" as const },
    { id: "d2", label: "Bollo", amount: 180, dueDate: "2027-01-31", source: "deadline" as const },
  ];
  const p = projectMonth(rec, txs, "2026-12", TODAY, planned);
  assert.equal(p.paid, 0);
  assert.deepEqual(p.planned.map((x) => x.label), ["Assicurazione auto"]);
  assert.equal(p.expected, Math.round((9.99 + 54.87 + 100 + 40 + 320) * 100) / 100);
});

test("senza storico sufficiente non inventa ricorrenze", () => {
  const few = [tx("A", "2026-11-03", -12, "Palestra")];
  assert.deepEqual(findRecurring(few, accounts, TODAY), []);
});
