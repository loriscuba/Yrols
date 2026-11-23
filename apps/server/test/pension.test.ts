import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { readXlsxRows } from "../src/xlsxRead.ts";
import { isPending, paidBreakdown, parseContributions, parseSintesi } from "../src/pension.ts";

// Dati inventati: il repository è pubblico.

/** Zip minimo (deflate) con i file dati, come un .xlsx salvato da Excel. */
function zip(files: Record<string, string>): Uint8Array {
  const local: Buffer[] = [], central: Buffer[] = [];
  let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text), data = deflateRawSync(raw), nm = Buffer.from(name);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(8, 8); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(nm.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(8, 10); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(off, 42);
    local.push(h, nm, data); central.push(c, nm);
    off += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return new Uint8Array(Buffer.concat([...local, cd, end]));
}

const HEAD = ["Periodo", "Anno", "Totale", "Aderente", "Azienda", "TFR", "Volontario", "TFR Silente", "Rivalutazione Contributo TFR", "Welfare", "Trasferimento / Reintegro", "Stato Contributo", "Tipologia"];
const strings = [...HEAD, "10", "2026", "Spesato", "Contributo", "9", "Quotato", "4", "2025", "Da altro fondo"];
const s = (v: string) => `t="s"><v>${strings.indexOf(v)}</v>`;
const row = (r: number, cells: string[]) => `<row r="${r}">${cells.map((c, i) => `<c r="${String.fromCharCode(65 + i)}${r}" ${c}</c>`).join("")}</row>`;
const n = (v: number) => `><v>${v}</v>`;
const sheet = `<?xml version="1.0"?><worksheet><sheetData>${[
  row(1, HEAD.map(s)),
  row(2, [s("10"), s("2026"), n(100), n(10), n(20), n(60), n(10), n(0), n(0), n(0), n(0), s("Spesato"), s("Contributo")]),
  row(3, [s("9"), s("2026"), n(150.5), n(15), n(30.5), n(90), n(15), n(0), n(0), n(0), n(0), s("Quotato"), s("Contributo")]),
  // Riga con celle vuote (come il trasferimento nell'Excel vero) e welfare.
  `<row r="4"><c r="A4" ${s("4")}</c><c r="B4" ${s("2025")}</c><c r="C4"><v>1000</v></c><c r="D4"><v>0</v></c><c r="K4"><v>1000</v></c><c r="L4" ${s("Quotato")}</c><c r="M4" ${s("Da altro fondo")}</c></row>`,
  row(5, [s("9"), s("2026"), n(40), n(0), n(0), n(0), n(0), n(0), n(0), n(40), n(0), s("Quotato"), s("Contributo")]),
].join("")}</sheetData></worksheet>`;
const sst = `<sst>${strings.map((t) => `<si><t>${t.replace("&", "&amp;")}</t></si>`).join("")}</sst>`;

test("Excel importi versati: righe, colonne e totali per tipo", async () => {
  const rows = await readXlsxRows(zip({ "xl/sharedStrings.xml": sst, "xl/worksheets/sheet1.xml": sheet }));
  assert.equal(rows.length, 5);
  const list = parseContributions(rows);
  assert.equal(list.length, 4);
  assert.deepEqual(list[0], { year: 2026, period: 10, total: 100, employee: 10, employer: 20, tfr: 60, voluntary: 10, tfrSilent: 0, tfrRevaluation: 0, welfare: 0, transfer: 0, status: "Spesato", kind: "Contributo" });
  assert.equal(list[2]!.transfer, 1000);
  assert.equal(list[2]!.kind, "Da altro fondo");
  assert.deepEqual(paidBreakdown(list), { total: 1290.5, employee: 50, employer: 50.5, tfr: 150, transfer: 1000, welfare: 40 });
  assert.deepEqual(list.filter(isPending).map((c) => c.total), [100]);
});

test("Excel sbagliato: errore chiaro", async () => {
  assert.throws(() => parseContributions([["Data", "Importo"], ["01/01/2026", 10]]), /importi versati/);
  await assert.rejects(readXlsxRows(new Uint8Array([1, 2, 3])), /Excel/);
});

const SINTESI = `Sintesi Posizione Individuale
01/03/2026
Quanto hai maturato al 01/03/2026
Importi versati   Prestazioni godute   Risultato gestione   Totale posizione
1.290,50 €   -   0,00 €   +   109,50 €   =   1.400,00 €
Posizione individuale al 01/03/2026
Contributi lavoratore   50,00 €   Anticipazioni   0,00 €
Posizione individuale al 01/03/2026   1.400,00 €
Composizione e consistenza posizione
Comparto   Quote in essere   Valore quota   Controvalore   Composizione per strumenti finanziari
DINAMICO   43,750   29,71   1.299,81 €
35,00% Obbligazioni
Importo in attesa di investimento   100,19 €
63,00% Azioni
Posizione individuale al 01/03/2026   1.400,00 €   2,00% Liquidità
Dettaglio operazioni recenti
Tipologia   Valore quota   Data quota   Entrate   Uscite   Comparto   N. Quota
CONTRIBUTO   29,71   31/01/2026   150,50 €   0,00 €   DINAMICO   5,066
CONTRIBUTO   29,50   31/12/2025   40,00 €   0,00 €   DINAMICO   1,356
Importi in attesa di investimento
Tipologia   Anno   Periodo   Comparto   Importo
CONTRIBUTO   2026   2   Dinamico   100,19 €`;

test("sintesi PDF: totale, quote, valore quota e composizione", () => {
  assert.deepEqual(parseSintesi(SINTESI), {
    date: "2026-03-01", paid: 1290.5, benefits: 0, result: 109.5, total: 1400, comparto: "Dinamico",
    units: 43.75, unitValue: 29.71, unitValueDate: "2026-01-31", invested: 1299.81, pending: 100.19,
    allocation: { Obbligazioni: 35, Azioni: 63, "Liquidità": 2 },
  });
  assert.throws(() => parseSintesi("Fattura n. 12 del 01/03/2026"), /sintesi/);
});
