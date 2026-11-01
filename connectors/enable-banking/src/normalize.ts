import { createHash } from "node:crypto";
import type { Account, Balance, EbAccount, EbBalance, EbTransaction, Transaction } from "./types.js";

/** Ordine di preferenza del saldo da mostrare (concordato con il cruscotto). */
export const BALANCE_PREFERENCE = ["ITAV", "CLAV", "XPCD", "CLBD"];

export function parseAmount(value: string | number | undefined | null): number {
  if (value === undefined || value === null || value === "") return 0;
  const n = typeof value === "number" ? value : Number(String(value).replace(",", "."));
  if (!Number.isFinite(n)) throw new Error(`Importo non valido: ${value}`);
  // Arrotonda a 2 decimali evitando artefatti floating point.
  return Math.round(n * 100) / 100;
}

const day = (iso: string | null | undefined): string | undefined => (iso ? iso.slice(0, 10) : undefined);

export function normalizeAccount(raw: EbAccount, bankName?: string, connectionId?: string): Account {
  const iban = raw.account_id?.iban ?? undefined;
  const name = raw.name || raw.product || raw.details || (iban ? `Conto ${iban.slice(-4)}` : undefined);
  const out: Account = { id: raw.uid };
  if (iban) out.iban = iban;
  if (name) out.name = name;
  if (raw.currency) out.currency = raw.currency;
  if (bankName) out.bankName = bankName;
  if (connectionId) out.connectionId = connectionId;
  return out;
}

export function normalizeBalance(raw: EbBalance, accountId: string, today = new Date()): Balance {
  return {
    accountId,
    amount: parseAmount(raw.balance_amount.amount),
    currency: raw.balance_amount.currency,
    type: raw.balance_type,
    date: day(raw.reference_date) ?? day(raw.last_change_date_time) ?? today.toISOString().slice(0, 10),
  };
}

/** Sceglie il saldo "principale" secondo BALANCE_PREFERENCE, poi il più recente. */
export function pickPrimaryBalance(balances: Balance[]): Balance | undefined {
  const rank = (t: string) => {
    const i = BALANCE_PREFERENCE.indexOf(t);
    return i === -1 ? BALANCE_PREFERENCE.length : i;
  };
  return [...balances].sort((a, b) => rank(a.type) - rank(b.type) || b.date.localeCompare(a.date))[0];
}

export function normalizeTransaction(raw: EbTransaction, accountId: string): Transaction {
  const abs = Math.abs(parseAmount(raw.transaction_amount.amount));
  const amount = raw.credit_debit_indicator === "DBIT" ? -abs : abs;
  const bookingDate = day(raw.booking_date) ?? day(raw.transaction_date) ?? day(raw.value_date) ?? "";
  const valueDate = day(raw.value_date);
  const counterparty = (raw.credit_debit_indicator === "DBIT" ? raw.creditor?.name : raw.debtor?.name) ?? undefined;
  const description =
    [...(raw.remittance_information ?? []), raw.note ?? ""].map((s) => s.trim()).filter(Boolean).join(" ") ||
    raw.bank_transaction_code?.description ||
    counterparty ||
    "";
  const id = raw.entry_reference || raw.transaction_id || syntheticId(raw, accountId, amount, bookingDate, description);
  const out: Transaction = {
    id,
    accountId,
    amount,
    currency: raw.transaction_amount.currency,
    bookingDate,
    description,
    status: raw.status === "PDNG" ? "PDNG" : "BOOK",
  };
  if (valueDate) out.valueDate = valueDate;
  if (counterparty) out.counterparty = counterparty;
  return out;
}

/** Alcune banche non forniscono un id: ne costruiamo uno stabile dai contenuti. */
function syntheticId(raw: EbTransaction, accountId: string, amount: number, bookingDate: string, description: string): string {
  const h = createHash("sha256")
    .update([accountId, bookingDate, day(raw.value_date) ?? "", amount.toFixed(2), raw.transaction_amount.currency, description, raw.reference_number ?? ""].join("|"))
    .digest("hex");
  return `h_${h.slice(0, 32)}`;
}
