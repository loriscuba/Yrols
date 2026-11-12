import { test } from "node:test";
import assert from "node:assert/strict";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { analyzeEmail } from "../src/invoiceEmail.ts";
import type { GetDocument } from "../src/pdfText.ts";

/** PDF minimo con righe di testo [x, y, testo] (solo per i test). */
function tinyPdf(lines: [number, number, string][]): Uint8Array {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => "\\" + c);
  const stream = lines.map(([x, y, s]) => `BT /F1 10 Tf ${x} ${y} Td (${esc(s)}) Tj ET`).join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ];
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(out);
}

const pdf = tinyPdf([
  [40, 800, "FASTWEB S.p.A."], [300, 700, "Totale da Pagare"], [450, 700, "EUR 42,19"],
  [300, 680, "Data di Scadenza"], [450, 680, "25/11/2026"], [40, 600, "Fattura N. M000111222"],
  [40, 580, "Fastweb Casa Full"], [400, 580, "33,95"], [480, 580, "22%"],
]);

test("fattura PDF allegata alla mail: dati dal PDF", async () => {
  const s = await analyzeEmail({ from: "Fastweb <noreply@fastweb.it>", subject: "Il tuo conto Fastweb", text: "Ciao, in allegato il conto.", pdfs: [{ filename: "conto.pdf", content: pdf }] },
    getDocument as unknown as GetDocument);
  assert.ok(s);
  assert.deepEqual([s.provider, s.billKind, s.amount, s.dueDate, s.invoiceNumber], ["Fastweb", "internet", 42.19, "2026-11-25", "M000111222"]);
  assert.deepEqual(s.items, [{ description: "Fastweb Casa Full", amount: 33.95, vat: 22 }]);
  assert.equal(s.pdf?.filename, "conto.pdf");
});

test("PDF illeggibile: si usa il testo della mail", async () => {
  const s = await analyzeEmail({ from: "A2A <x@a2a.eu>", subject: "Nuova bolletta", text: "Il totale da pagare è di 50,00 € con scadenza 03/12/2026.",
    pdfs: [{ filename: "rotto.pdf", content: new TextEncoder().encode("non sono un pdf") }] }, getDocument as unknown as GetDocument);
  assert.deepEqual([s?.provider, s?.amount, s?.pdf], ["A2A", 50, null]);
});
