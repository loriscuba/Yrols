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

/** PDF con testo e campi modulo compilati [nome, valore] (come certi F24 dei Comuni). */
function formPdf(lines: [number, number, string][], fields: [string, string][]): Uint8Array {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => "\\" + c);
  const stream = lines.map(([x, y, s]) => `BT /F1 10 Tf ${x} ${y} Td (${esc(s)}) Tj ET`).join("\n");
  const annots = fields.map((_, i) => `${6 + i} 0 R`).join(" ");
  const objs = [
    `<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [${annots}] >> >>`,
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Annots [${annots}] /Resources << /Font << /F1 5 0 R >> >> >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    ...fields.map(([n, v], i) => `<< /Type /Annot /Subtype /Widget /FT /Tx /T (${esc(n)}) /V (${esc(v)}) /Rect [400 ${500 - i * 20} 500 ${515 - i * 20}] /P 3 0 R >>`),
  ];
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(out);
}

const tariMail = { from: "Ufficio Tributi <tributi@comune.example.it>", subject: "TARI 2026",
  text: "Buongiorno, in allegato si trasmette modello F24 in rata unica con scadenza 02/12/2026 relativo alla Tari anno 2026." };

test("TARI: importo dal modello F24 allegato, scadenza dalla mail", async () => {
  const f24 = tinyPdf([
    [40, 800, "MODELLO DI PAGAMENTO UNIFICATO F24"], [40, 700, "SEZIONE IMU E ALTRI TRIBUTI LOCALI"],
    [40, 680, "EL"], [80, 680, "Z999"], [140, 680, "3944"], [200, 680, "2026"], [300, 680, "287,40"],
    [40, 660, "EL"], [80, 660, "Z999"], [140, 660, "TEFA"], [200, 660, "2026"], [300, 660, "14,37"],
    [40, 600, "SALDO FINALE"], [200, 600, "EURO +"], [300, 600, "301,77"],
  ]);
  const s = await analyzeEmail({ ...tariMail, pdfs: [{ filename: "F24.pdf", content: f24 }] }, getDocument as unknown as GetDocument);
  assert.deepEqual([s?.kind, s?.title, s?.provider, s?.billKind, s?.amount, s?.dueDate, s?.pdf?.filename], ["deadline", "TARI 2026", "TARI", "rifiuti", 301.77, "2026-12-02", "F24.pdf"]);
});

test("F24 compilabile: importi nei campi del modulo", async () => {
  const f24 = formPdf([[40, 800, "Modello F24 - Delega irrevocabile"], [40, 700, "codice tributo 3944"], [40, 600, "SALDO FINALE EURO"]],
    [["saldo_finale", "156,00"]]);
  const s = await analyzeEmail({ ...tariMail, pdfs: [{ filename: "F24.pdf", content: f24 }] }, getDocument as unknown as GetDocument);
  assert.deepEqual([s?.provider, s?.amount, s?.dueDate], ["TARI", 156, "2026-12-02"]);
});

test("F24 con il modulo come immagine: importi nelle caselle (euro e centesimi separati)", async () => {
  // Dati inventati, con la stessa struttura del PDF che manda un Comune: solo i valori stampati sopra il modulo.
  const f24 = tinyPdf([
    [40, 800, "TARI RATA UNICA - SCAD 21/08/2026"],
    [40, 700, "E"], [55, 700, "L"], [90, 700, "3944"], [150, 700, "Z 9 9 9"], [250, 700, "2026"], [400, 700, "150 40"],
    [40, 680, "E"], [55, 680, "L"], [90, 680, "TEFA"], [150, 680, "Z 9 9 9"], [250, 680, "2026"], [400, 680, "7 50"],
    [400, 650, "157 90"],
  ]);
  const withMailDate = await analyzeEmail({ ...tariMail, pdfs: [{ filename: "F24.pdf", content: f24 }] }, getDocument as unknown as GetDocument);
  assert.deepEqual([withMailDate?.provider, withMailDate?.billKind, withMailDate?.amount, withMailDate?.dueDate], ["TARI", "rifiuti", 157.9, "2026-12-02"]);
  const pdfOnly = await analyzeEmail({ from: "tributi@comune.example.it", subject: "TARI", text: "In allegato il modello.", pdfs: [{ filename: "F24.pdf", content: f24 }] },
    getDocument as unknown as GetDocument);
  assert.deepEqual([pdfOnly?.amount, pdfOnly?.dueDate], [157.9, "2026-08-21"]);
});
