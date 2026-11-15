/**
 * Fatture dai PDF allegati alle email: legge ogni PDF e unisce i dati trovati con quelli del testo della mail.
 * I dati del PDF hanno la precedenza (sono quelli ufficiali della fattura).
 */
import { parseEmail, type ParsedEmail, type PdfAttachment, type Suggestion } from "./emailParser.ts";
import { isF24, looksLikeInvoice, parseInvoice, type Invoice } from "./invoiceParser.ts";
import { pdfToText, type GetDocument } from "./pdfText.ts";

export interface EmailInvoice extends Suggestion {
  invoiceNumber: string | null; issueDate: string | null; periodFrom: string | null; periodTo: string | null;
  items: Invoice["items"] | null; pdf: PdfAttachment | null;
}

export async function analyzeEmail(e: ParsedEmail, getDocument: GetDocument): Promise<EmailInvoice | null> {
  const fromBody = parseEmail(e);
  for (const pdf of e.pdfs ?? []) {
    let inv: Invoice, text: string;
    try { text = await pdfToText(getDocument, pdf.content.slice()); inv = parseInvoice(text); } catch { continue; } // PDF illeggibile o protetto
    // Un F24 non ha scadenza scritta sopra: vale quella della mail ("rata unica con scadenza 02/12/2026").
    if (!inv.dueDate && fromBody?.dueDate && inv.amount !== null && isF24(text)) inv.dueDate = fromBody.dueDate;
    if (!looksLikeInvoice(inv, text)) continue;
    const provider = inv.provider ?? fromBody?.provider ?? null;
    return {
      kind: "bill", provider, billKind: inv.kind ?? fromBody?.billKind ?? "altro", title: `Bolletta ${provider ?? ""}`.trim(),
      amount: inv.amount, dueDate: inv.dueDate ?? fromBody?.dueDate ?? null, snippet: fromBody?.snippet ?? e.text.replace(/\s+/g, " ").trim().slice(0, 240),
      invoiceNumber: inv.invoiceNumber, issueDate: inv.issueDate, periodFrom: inv.periodFrom, periodTo: inv.periodTo,
      items: inv.items.length ? inv.items : null, pdf,
    };
  }
  return fromBody && { ...fromBody, invoiceNumber: null, issueDate: null, periodFrom: null, periodTo: null, items: null, pdf: null };
}
