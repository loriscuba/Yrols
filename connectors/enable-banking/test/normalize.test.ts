import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeAccount, normalizeBalance, normalizeTransaction, pickPrimaryBalance } from "../src/normalize.js";

test("conto normalizzato", () => {
  assert.deepEqual(normalizeAccount({ uid: "u1", account_id: { iban: "IT00X123" }, currency: "EUR" }, "Banca", "s1"), {
    id: "u1",
    iban: "IT00X123",
    name: "Conto X123",
    currency: "EUR",
    bankName: "Banca",
    connectionId: "s1",
  });
});

test("saldo: importo numerico e data", () => {
  const b = normalizeBalance({ balance_amount: { currency: "EUR", amount: "-1234,50" }, balance_type: "CLBD", reference_date: "2026-10-01" }, "a");
  assert.deepEqual(b, { accountId: "a", amount: -1234.5, currency: "EUR", type: "CLBD", date: "2026-10-01" });
});

test("saldo principale: ITAV > CLAV > XPCD > CLBD", () => {
  const mk = (type: string, date = "2026-10-01") => ({ accountId: "a", amount: 1, currency: "EUR", type, date });
  assert.equal(pickPrimaryBalance([mk("CLBD"), mk("XPCD"), mk("ITAV")])?.type, "ITAV");
  assert.equal(pickPrimaryBalance([mk("OTHR"), mk("CLBD")])?.type, "CLBD");
  assert.equal(pickPrimaryBalance([mk("CLBD", "2026-09-01"), mk("CLBD", "2026-10-01")])?.date, "2026-10-01");
});

test("movimento in uscita ha segno negativo e controparte = creditore", () => {
  const t = normalizeTransaction(
    {
      entry_reference: "e1",
      transaction_amount: { currency: "EUR", amount: "82.10" },
      credit_debit_indicator: "DBIT",
      status: "BOOK",
      booking_date: "2026-10-30",
      creditor: { name: "Enel" },
      remittance_information: ["SDD ENEL", " bolletta "],
    },
    "a",
  );
  assert.equal(t.amount, -82.1);
  assert.equal(t.counterparty, "Enel");
  assert.equal(t.description, "SDD ENEL bolletta");
  assert.equal(t.id, "e1");
});

test("movimento senza id: id sintetico stabile", () => {
  const raw = {
    transaction_amount: { currency: "EUR", amount: "10" },
    credit_debit_indicator: "CRDT" as const,
    status: "PDNG" as const,
    booking_date: "2026-10-01",
    debtor: { name: "Mario" },
  };
  const a = normalizeTransaction(raw, "acc");
  const b = normalizeTransaction({ ...raw }, "acc");
  assert.match(a.id, /^h_[0-9a-f]{32}$/);
  assert.equal(a.id, b.id);
  assert.equal(a.amount, 10);
  assert.equal(a.status, "PDNG");
  assert.equal(a.description, "Mario");
});
