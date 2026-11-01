import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEmail, parseItalianAmount, findDueDate } from "../src/emailParser.ts";

test("importi in formato italiano", () => {
  assert.equal(parseItalianAmount("1.234,56"), 1234.56);
  assert.equal(parseItalianAmount("82,1"), 82.1);
  assert.equal(parseItalianAmount("82.10"), 82.1);
  assert.equal(parseItalianAmount("120"), 120);
});

test("date di scadenza", () => {
  assert.equal(findDueDate("Emessa il 01/10/2026, da pagare entro il 20/11/2026"), "2026-11-20");
  assert.equal(findDueDate("scade il 5 dicembre 2026"), "2026-12-05");
  assert.equal(findDueDate("data 31/02/2026"), null);
});

test("bolletta di un fornitore noto", () => {
  const s = parseEmail({ from: "A2A Energia <bollette@a2a.eu>", subject: "Nuova fattura n. 123",
    text: "Gentile cliente, il totale da pagare è di 1.045,20 € con scadenza 03/12/2026." });
  assert.equal(s?.kind, "bill");
  assert.equal(s?.provider, "A2A");
  assert.equal(s?.billKind, "luce");
  assert.equal(s?.amount, 1045.2);
  assert.equal(s?.dueDate, "2026-12-03");
});

test("scadenza: bollo auto", () => {
  const s = parseEmail({ from: "ACI <info@aci.it>", subject: "Promemoria bollo auto",
    text: "Il bollo della tua auto AB123CD scade il 31/01/2027. Importo € 245,00" });
  assert.equal(s?.kind, "deadline");
  assert.equal(s?.title, "Bollo auto");
  assert.equal(s?.dueDate, "2027-01-31");
});

test("ignora email non pertinenti e promozioni", () => {
  assert.equal(parseEmail({ from: "amico@x.it", subject: "Cena sabato?", text: "Ci vediamo alle 20" }), null);
  assert.equal(parseEmail({ from: "Vodafone <promo@vodafone.it>", subject: "Offerta speciale fibra", text: "Bolletta ridotta: € 19,90" }), null);
});
