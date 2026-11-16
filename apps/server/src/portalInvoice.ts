/**
 * Bollette scaricate dalle aree clienti dei fornitori (MyFastweb, MySorgenia, Iliad…): dal testo del PDF decide
 * se è una bolletta completa da salvare subito, una da completare a mano (proposta in "Da email"), o un PDF
 * che non è una fattura. Il fornitore dichiarato da chi l'ha scaricata vale se il PDF non lo dice.
 */
import { PROVIDERS } from "./emailParser.ts";
import { isF24, looksLikeInvoice, parseInvoice, type Invoice } from "./invoiceParser.ts";

export type PortalResult =
  | { result: "bill"; bill: PortalBill }
  | { result: "suggestion"; bill: PortalBill }
  | { result: "unreadable" };

export interface PortalBill {
  provider: string; kind: string; amount: number | null; dueDate: string | null;
  invoiceNumber: string | null; issueDate: string | null; periodFrom: string | null; periodTo: string | null;
  items: Invoice["items"] | null;
}

export function portalInvoice(text: string, declaredProvider: string | null): PortalResult {
  const inv = parseInvoice(text);
  if (isF24(text) || !looksLikeInvoice(inv, text)) return { result: "unreadable" };
  const declared = declaredProvider ? PROVIDERS.find(([re]) => re.test(declaredProvider)) : undefined;
  const bill: PortalBill = {
    provider: inv.provider ?? declared?.[1] ?? declaredProvider ?? "Fornitore",
    kind: inv.kind ?? declared?.[2] ?? "altro",
    amount: inv.amount, dueDate: inv.dueDate, invoiceNumber: inv.invoiceNumber, issueDate: inv.issueDate,
    periodFrom: inv.periodFrom, periodTo: inv.periodTo, items: inv.items.length ? inv.items : null,
  };
  return { result: bill.amount !== null && bill.dueDate ? "bill" : "suggestion", bill };
}
