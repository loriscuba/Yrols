import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEmail, parseItalianAmount, findDueDate, cleanSnippet, htmlToText, isNoise } from "../src/emailParser.ts";

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

test("pubblicità e avvisi di servizio non diventano proposte", () => {
  const cases: [string, string, string][] = [
    ["PayPal <news@news.paypal.example>", "Paga in 3 rate senza interessi", "Scopri di più. Totale fino a € 2.000,00"],
    ["Treatwell <noreply@treatwell.example>", "Prenotazione confermata: taglio", "Il tuo appuntamento del 20/11/2026, € 35,00"],
    ["Enjoy <info@enjoy.example>", "Aggiornamento del servizio", "Dal 01/12/2026 cambia la tariffa: 0,29 € al minuto"],
    ["Revolut <no-reply@revolut.example>", "Aggiornamento dei Termini e condizioni", "Le nuove condizioni valgono dal 01/01/2027"],
    ["Facile.it <assicurazioni@remind.facile.example>", "La tua RC auto scade: risparmia", "Polizza in scadenza il 30/11/2026, da € 199,00"],
  ];
  for (const [from, subject, text] of cases) assert.equal(parseEmail({ from, subject, text }), null, subject);
  assert.equal(isNoise("Hera <bollette@hera.example>", "La tua bolletta gas"), false);
});

test("una parola chiave nel solo testo non basta senza una scadenza esplicita", () => {
  assert.equal(parseEmail({ from: "Banca <info@banca.example>", subject: "Novembre in breve", text: "Ricorda il bollo auto, rinnovo semplice in app." }), null);
});

test("anteprima leggibile: niente CSS, link e HTML", () => {
  const html = `<html><head><style>body{color:red}</style></head><body><p>Ciao Mario,</p><p>la tua bolletta&nbsp;è pronta.<br>Vedi <a href="https://x.example">qui</a></p></body></html>`;
  const t = htmlToText(html);
  assert.ok(!t.includes("color:red"));
  assert.match(t, /bolletta è pronta/);
  const s = cleanSnippet("td { padding: 0 } Accedi (https://example.com/a/very/long/path?token=abcdefghijklmnopqrstuvwxyz0123456789) e **paga** entro il 16/11/2026 [https://example.com/x]");
  assert.equal(s, "Accedi e paga entro il 16/11/2026");
});
