/**
 * Scorporo di una bolletta in più servizi, a partire dalle voci di costo lette dal PDF.
 * Esempio: il conto Fastweb contiene la linea di casa (internet + telefono fisso) e la SIM Fastweb Mobile:
 * le due parti si mostrano separate in Bollette e si confrontano con offerte diverse in Risparmio.
 * Logica pura, la usano il cruscotto web e i test.
 */
import type { InvoiceItem } from "./invoiceParser.ts";

export type BillPart = "internet" | "telefono";
export const PART_LABEL: Record<BillPart, string> = { internet: "Internet casa", telefono: "Telefonia mobile" };

const MOBILE = /\b(mobile|sim|ricarica|giga|gb\b|roaming|cellulare|smartphone|esim)/i;
const HOME = /\b(casa|internet|fibra|adsl|ftth|fttc|fwa|modem|router|wi-?fi|rete fissa|linea fissa|telefono fisso|voce fissa)/i;
const TELCO_KINDS = new Set(["internet", "telefono"]);

/** A quale servizio appartiene una voce di costo; null se non si capisce (es. "Contributo attivazione"). */
export function itemPart(description: string): BillPart | null {
  if (MOBILE.test(description)) return "telefono";
  if (HOME.test(description)) return "internet";
  return null;
}

/** Voci che non si ripetono ogni mese: accrediti, storni, conguagli, rimborsi. */
export const isOneOff = (i: InvoiceItem) => i.amount < 0 || /\b(accredit|storn|conguagl|rimbors|una tantum|bonus|sconto)/i.test(i.description);

export interface PartTotal { part: BillPart; label: string; amount: number; monthly: number }

/**
 * Totali per servizio di una bolletta di internet/telefonia. Restituisce [] se la bolletta non ha voci
 * di servizi diversi (in quel caso non c'è niente da scorporare).
 * - amount: quanto pesa il servizio su QUESTA bolletta (accrediti compresi, la somma fa il totale delle voci);
 * - monthly: la spesa che si ripete ogni mese (senza accrediti e storni), usata per i confronti in Risparmio.
 * Le voci generiche (contributo di attivazione, costi di spedizione…) vanno al servizio principale della bolletta.
 */
export function billParts(bill: { kind: string; items?: InvoiceItem[] | null }): PartTotal[] {
  const items = bill.items ?? [];
  if (!TELCO_KINDS.has(bill.kind) || items.length < 2) return [];
  const main = bill.kind as BillPart;
  const parts = items.map((i) => itemPart(i.description) ?? main);
  if (new Set(parts).size < 2) return [];
  const out = new Map<BillPart, PartTotal>();
  items.forEach((i, n) => {
    const p = parts[n]!;
    const t = out.get(p) ?? { part: p, label: PART_LABEL[p], amount: 0, monthly: 0 };
    t.amount += i.amount;
    if (!isOneOff(i)) t.monthly += i.amount;
    out.set(p, t);
  });
  return (["internet", "telefono"] as BillPart[]).flatMap((p) => {
    const t = out.get(p);
    return t ? [{ ...t, amount: round(t.amount), monthly: round(t.monthly) }] : [];
  });
}

/**
 * Per ogni fornitore, lo scorporo dell'ultima bolletta che si può dividere (chiave: nome in minuscolo).
 * Serve a Risparmio per confrontare separatamente internet di casa e SIM dello stesso fornitore.
 */
export function latestSplits(bills: { provider: string; kind: string; dueDate: string; items?: InvoiceItem[] | null }[]) {
  const out = new Map<string, { provider: string; parts: PartTotal[] }>();
  for (const b of [...bills].sort((a, b) => b.dueDate.localeCompare(a.dueDate))) {
    const key = b.provider.trim().toLowerCase();
    if (out.has(key)) continue;
    const parts = billParts(b);
    if (parts.length) out.set(key, { provider: b.provider, parts });
  }
  return out;
}

const round = (n: number) => Math.round(n * 100) / 100;
