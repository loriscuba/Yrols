/**
 * Testo di un PDF riga per riga, ricostruito dalle posizioni dei frammenti (pdf.js).
 * Le colonne sulla stessa riga sono separate da tre spazi, così il parser distingue etichette e valori.
 * pdf.js si passa da fuori: nel browser il build standard con il worker, in Node il build "legacy".
 */
interface TextItem { str?: string; transform?: number[]; width?: number }
interface PdfDoc { numPages: number; getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }>; destroy?(): Promise<void> }
export type GetDocument = (src: { data: Uint8Array; isEvalSupported?: boolean; useSystemFonts?: boolean }) => { promise: Promise<PdfDoc> };

export function linesFromItems(items: unknown[]): string[] {
  const rows: { y: number; parts: { x: number; s: string; w: number }[] }[] = [];
  for (const raw of items as TextItem[]) {
    if (!raw.str?.trim() || !raw.transform) continue;
    const x = raw.transform[4]!, y = raw.transform[5]!;
    let r = rows.find((r) => Math.abs(r.y - y) < 3);
    if (!r) rows.push((r = { y, parts: [] }));
    r.parts.push({ x, s: raw.str, w: raw.width ?? 0 });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((r) => {
    r.parts.sort((a, b) => a.x - b.x);
    let line = "", end: number | null = null;
    for (const p of r.parts) {
      if (end !== null) line += p.x - end > 8 ? "   " : p.x - end > 1 && !line.endsWith(" ") && !p.s.startsWith(" ") ? " " : "";
      line += p.s;
      end = p.x + p.w;
    }
    return line.trim();
  });
}

export async function pdfToText(getDocument: GetDocument, data: Uint8Array, maxPages = 10): Promise<string> {
  const doc = await getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise;
  try {
    const out: string[] = [];
    for (let p = 1; p <= Math.min(doc.numPages, maxPages); p++) {
      const page = await doc.getPage(p);
      out.push(...linesFromItems((await page.getTextContent()).items));
    }
    return out.join("\n");
  } finally {
    await doc.destroy?.();
  }
}
