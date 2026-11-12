/**
 * Legge una fattura PDF nel browser: il file non lascia il dispositivo finché non lo salvi.
 * Il riconoscimento dei campi è lo stesso usato per i PDF allegati alle email.
 */
import { parseInvoice, type Invoice } from "../../server/src/invoiceParser.ts";
import { pdfToText, type GetDocument } from "../../server/src/pdfText.ts";

export type { Invoice };

export async function readInvoicePdf(file: File): Promise<Invoice> {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const text = await pdfToText(pdfjs.getDocument as unknown as GetDocument, new Uint8Array(await file.arrayBuffer()));
  return parseInvoice(text);
}
