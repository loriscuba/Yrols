/**
 * Fatture dai PDF allegati alle email: legge ogni PDF e unisce i dati trovati con quelli del testo della mail.
 * I dati del PDF hanno la precedenza (sono quelli ufficiali della fattura).
 */
import { cleanSnippet, parseEmail, type ParsedEmail, type PdfAttachment, type Suggestion } from "./emailParser.ts";
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
    // Per un F24 vale la scadenza scritta nella mail ("rata unica con scadenza 02/12/2026"): il Comune spesso
    // rimanda lo stesso modulo con una data aggiornata. Se la mail non la dice, si usa quella del modulo.
    if (fromBody?.dueDate && inv.amount !== null && isF24(text)) inv.dueDate = fromBody.dueDate;
    if (!looksLikeInvoice(inv, text)) continue;
    const provider = inv.provider ?? fromBody?.provider ?? null;
    // Un F24 (TARI, IMU…) è una tassa: va tra le Scadenze, non tra le bollette dei fornitori.
    const f24 = isF24(text);
    const year = f24 ? text.match(/\b(?:39\d\d|TEFA)\b.*?\b(20\d\d)\b/)?.[1] : undefined;
    return {
      kind: f24 ? "deadline" : "bill", provider, billKind: inv.kind ?? fromBody?.billKind ?? "altro",
      title: f24 ? [provider ?? "Pagamento F24", year].filter(Boolean).join(" ") : `Bolletta ${provider ?? ""}`.trim(),
      amount: inv.amount, dueDate: inv.dueDate ?? fromBody?.dueDate ?? null, snippet: fromBody?.snippet ?? cleanSnippet(e.text),
      invoiceNumber: inv.invoiceNumber, issueDate: inv.issueDate, periodFrom: inv.periodFrom, periodTo: inv.periodTo,
      items: inv.items.length ? inv.items : null, pdf,
    };
  }
  return fromBody && { ...fromBody, invoiceNumber: null, issueDate: null, periodFrom: null, periodTo: null, items: null, pdf: null };
}
