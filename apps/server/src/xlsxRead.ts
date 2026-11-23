/**
 * Lettore minimo di file Excel (.xlsx) senza librerie: un .xlsx è uno zip di XML.
 * Legge il primo foglio come righe di celle (testo o numero). Funziona nel browser e in Node 22
 * (DecompressionStream "deflate-raw"), così il file non lascia il dispositivo finché non lo salvi.
 */
export type Cell = string | number | null;

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** File dello zip per nome, letti dalla directory centrale (le dimensioni nelle intestazioni locali possono mancare). */
export async function unzip(buf: Uint8Array, wanted: (name: string) => boolean): Promise<Map<string, string>> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("Il file non è un Excel .xlsx valido");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map<string, string>();
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("Excel danneggiato");
    const method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!wanted(name)) continue;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const raw = buf.subarray(start, start + size);
    if (method !== 0 && method !== 8) throw new Error("Compressione dell'Excel non supportata");
    out.set(name, dec.decode(method === 8 ? await inflate(raw) : raw));
  }
  return out;
}

const unescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, "&");
const texts = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescape(m[1]!)).join("");

function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, "")) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Righe del primo foglio di un .xlsx. */
export async function readXlsxRows(data: Uint8Array): Promise<Cell[][]> {
  const files = await unzip(data, (n) => n === "xl/sharedStrings.xml" || n === "xl/workbook.xml" || n === "xl/_rels/workbook.xml.rels" || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  // Primo foglio del libro (di solito sheet1.xml, ma segue i collegamenti se diverso).
  let sheet = "xl/worksheets/sheet1.xml";
  const rid = files.get("xl/workbook.xml")?.match(/<sheet\b[^>]*\br:id="([^"]+)"/)?.[1];
  const target = rid && files.get("xl/_rels/workbook.xml.rels")?.match(new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*Target="([^"]+)"|<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${rid}"`));
  const t = target ? target[1] ?? target[2] : null;
  if (t) sheet = t.startsWith("/") ? t.slice(1) : "xl/" + t.replace(/^\.\//, "");
  const xml = files.get(sheet) ?? [...files.entries()].find(([n]) => n.startsWith("xl/worksheets/"))?.[1];
  if (!xml) throw new Error("L'Excel non contiene fogli");
  const shared = [...(files.get("xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]!));
  const rows: Cell[][] = [];
  for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: Cell[] = [];
    for (const c of r[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1]!, body = c[2] ?? "";
      const ref = attrs.match(/\br="([A-Z]+\d+)"/)?.[1];
      const type = attrs.match(/\bt="([^"]+)"/)?.[1];
      const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let val: Cell = null;
      if (type === "s" && v !== undefined) val = shared[Number(v)] ?? null;
      else if (type === "inlineStr") val = texts(body);
      else if (type === "str" || type === "e") val = v === undefined ? null : unescape(v);
      else if (type === "b") val = v === "1" ? 1 : 0;
      else if (v !== undefined && v !== "") val = Number(v);
      const i = ref ? colIndex(ref) : row.length;
      while (row.length < i) row.push(null);
      row[i] = val;
    }
    rows.push(row);
  }
  return rows;
}
