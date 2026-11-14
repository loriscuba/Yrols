import { test } from "node:test";
import assert from "node:assert/strict";
import { findRecurring, type RecTx } from "../src/recurring.ts";
import { buildSuppliers, identify, slug } from "../src/suppliers.ts";

// Dati inventati: un conto, movimenti da agosto a metà novembre.
const accounts = [{ id: "A", name: "ROSSI MARIO" }];
let n = 0;
const tx = (bookingDate: string, amount: number, description: string, counterparty: string | null = null): RecTx =>
  ({ id: `t${++n}`, accountId: "A", bookingDate, amount, description, counterparty });
const TODAY = "2026-11-14";

const txs: RecTx[] = [
  ...["2026-08-25", "2026-09-25", "2026-10-25"].map((d) => tx(d, -37.9, "FASTWEB SpA Addebito SDD fattura a Vs carico da IT00X0000000000")),
  tx("2026-08-18", -61.2, "Sorgenia S.p.A. Addebito SDD fattura a Vs carico da IT99Z1111"), tx("2026-10-17", -48.4, "Sorgenia S.p.A. Addebito SDD fattura a Vs carico da IT99Z1111"),
  ...["2026-08-13", "2026-09-13", "2026-10-13", "2026-11-13"].map((d) => tx(d, -120, "Quota Mensile, amministrazione ordinaria", "CONDOMINIO VIA ROMA 1A - 1B")),
  ...["2026-08-20", "2026-09-20", "2026-10-20"].map((d) => tx(d, -69.3, "Rata mensile, Esercizio Straordinario", "Condominio Via Roma")),
  tx("2026-09-02", -22.5, "Iliad Italia", "Iliad Italia"),
  ...["2026-08-07", "2026-09-07", "2026-10-07", "2026-11-07"].map((d) => tx(d, -9.99, "Streaming Plus", "Streaming Plus")),
  ...["2026-08-03", "2026-09-12", "2026-10-02"].map((d, i) => tx(d, -(20 + i * 7), "Supermercato Centro", "Supermercato Centro")),
  tx("2026-10-30", 15, "Rimborso Fastweb"),
];
const recurring = findRecurring(txs, accounts, TODAY);
const build = (extra: Partial<Parameters<typeof buildSuppliers>[0]> = {}) => buildSuppliers({ txs, recurring, today: TODAY, ...extra });

test("identify riconosce fornitori e condominio dal testo", () => {
  assert.deepEqual(identify("FASTWEB SpA Addebito SDD"), { name: "Fastweb", kind: "internet" });
  assert.deepEqual(identify("Sorgenia S.p.A."), { name: "Sorgenia", kind: "luce" });
  assert.deepEqual(identify("CONDOMINIO VIA ROMA 1A - 1B"), { name: "Condominio Via Roma", kind: "condominio" });
  assert.equal(identify("Supermercato Centro"), null);
  assert.equal(identify("Eni 01397"), null, "distributore di carburante, non la bolletta");
  assert.equal(identify("ESTRATTO CONTO AL 30/09/26"), null);
  assert.equal(identify("Eni Plenitude S.p.A. Addebito SDD")?.kind, "gas");
  assert.equal(slug("Condominio Via Roma"), "condominio-via-roma");
});

test("anagrafica: utenze dai movimenti, condominio unico, altri addebiti a parte", () => {
  const s = build();
  const by = new Map(s.map((x) => [x.key, x]));
  const fw = by.get("fastweb")!;
  assert.equal(fw.utility, true);
  assert.equal(fw.kind, "internet");
  assert.equal(fw.directDebit, true);
  assert.equal(fw.creditorId, "IT00X0000000000");
  assert.equal(fw.monthly, 37.9);
  assert.equal(fw.payments.length, 3, "il rimborso in entrata non conta");
  assert.equal(fw.lastPayment?.date, "2026-10-25");

  // Sorgenia è bimestrale: non è ricorrente ma è riconosciuta dal catalogo.
  const sg = by.get("sorgenia")!;
  assert.equal(sg.utility, true);
  assert.ok(sg.monthly > 0 && sg.monthly < 61.2);

  // Le due rate dello stesso condominio finiscono nella stessa scheda.
  const condo = by.get("condominio-via-roma")!;
  assert.equal(condo.kind, "condominio");
  assert.equal(condo.recurring.length, 2);
  assert.equal(condo.monthly, 189.3);

  assert.equal(by.get("iliad")!.kind, "telefono");
  // Abbonamento non di utenza: proposto tra gli altri addebiti; il supermercato no.
  const sp = s.find((x) => x.name === "Streaming Plus")!;
  assert.equal(sp.utility, false);
  assert.ok(!s.some((x) => /supermercato/i.test(x.name)));
  // Le utenze vengono prima.
  const firstOther = s.findIndex((x) => !x.utility);
  assert.ok(s.slice(firstOther).every((x) => !x.utility));
});

test("bollette, email e schede salvate", () => {
  const s = build({
    bills: [{ id: 1, provider: "Enel Energia", kind: "luce", amount: 120, dueDate: "2026-10-10" }, { id: 2, provider: "FASTWEB", kind: "internet", amount: 37.9, dueDate: "2026-10-25", invoiceNumber: "M1" }],
    emails: [{ id: 9, provider: "Acea", billKind: "acqua", amount: 40, dueDate: "2026-12-01", kind: "bill" }, { id: 10, provider: "Comune", amount: null, dueDate: null, kind: "deadline" }],
    saved: [
      { id: 1, key: "fastweb", name: "Fastweb Casa", kind: "internet", status: "attivo", customerCode: "C123" },
      { id: 2, key: "iliad", name: "Iliad", kind: "telefono", status: "nascosto" },
      { id: 3, key: "streaming-plus", name: "Streaming Plus", kind: "altro", status: "attivo" },
      { id: 4, key: "assicurazione-casa", name: "Assicurazione casa", kind: "altro", status: "attivo" },
    ],
  });
  const by = new Map(s.map((x) => [x.key, x]));
  assert.equal(by.get("fastweb")!.name, "Fastweb Casa");
  assert.equal(by.get("fastweb")!.sources.bills, 1);
  assert.equal(by.get("fastweb")!.saved?.customerCode, "C123");
  assert.equal(by.get("enel-energia")!.monthly, 10, "solo bolletta: un anno diviso 12");
  assert.equal(by.get("acea")!.sources.email, 1);
  assert.equal(by.get("acea")!.kind, "acqua");
  assert.ok(!by.has("comune"), "le scadenze non sono fornitori");
  assert.equal(by.get("iliad")!.hidden, true);
  assert.equal(by.get("streaming-plus")!.utility, true, "aggiunto all'anagrafica");
  assert.equal(by.get("assicurazione-casa")!.sources.bank, 0, "inserito a mano");
});
