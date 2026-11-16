/** pdf.js in Node, con le mappe dei caratteri e i font standard: senza, i PDF con font CID (molti F24) danno testo vuoto. */
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { GetDocument } from "./pdfText.ts";

const pdfjsDir = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
export const readPdf: GetDocument = (src) => (getDocument as unknown as GetDocument)({
  ...src, cMapUrl: join(pdfjsDir, "cmaps") + "/", cMapPacked: true, standardFontDataUrl: join(pdfjsDir, "standard_fonts") + "/",
});
