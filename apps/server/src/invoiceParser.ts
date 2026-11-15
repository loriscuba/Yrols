/**
 * Riconosce i dati di una fattura dal testo del suo PDF (fornitori italiani: Fastweb, Enel, A2A, …).
 * Funzione pura e senza dipendenze: la usano sia il cruscotto (PDF caricato a mano, letto nel browser)
 * sia la lettura email (PDF allegati). Il testo arriva da pdfText(), una riga del PDF per riga di testo.
 */
import { PROVIDERS, parseItalianAmount } from "./emailParser.ts";

export interface InvoiceItem { description: string; amount: number; vat: number | null }
export interface Invoice {
  provider: string | null;
  kind: string | null;
  invoiceNumber: string | null;
  issueDate: string | null;
  dueDate: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  amount: number | null;
  items: InvoiceItem[];
}

const MONTHS: Record<string, number> = {
  gen: 1, feb: 2, mar: 3, apr: 4, mag: 5, giu: 6, lug: 7, ago: 8, set: 9, ott: 10, nov: 11, dic: 12,
};
const MONTH_WORD = "(gen(?:naio)?|feb(?:braio)?|mar(?:zo)?|apr(?:ile)?|mag(?:gio)?|giu(?:gno)?|lug(?:lio)?|ago(?:sto)?|set(?:tembre)?|ott(?:obre)?|nov(?:embre)?|dic(?:embre)?)\\.?";
const D = `(?:\\d{1,2}[/.\\-]\\d{1,2}[/.\\-]\\d{2,4}|\\d{1,2}\\s+${MONTH_WORD.replace("(", "(?:")}\\s+\\d{4})`;
const DATE_ONE = new RegExp(`(\\d{1,2})[/.\\-](\\d{1,2})[/.\\-](\\d{2,4})|(\\d{1,2})\\s+${MONTH_WORD}\\s+(\\d{4})`, "i");
const AMOUNT = "(-?\\s?\\d{1,3}(?:\\.\\d{3})*,\\d{2}|-?\\d+[.,]\\d{2})";

/** "25 Nov 2026", "25/11/2026", "5 dicembre 2026" → "2026-11-25" */
export function toIsoDate(s: string): string | null {
  const m = s.match(DATE_ONE);
  if (!m) return null;
  let [d, mo, y] = m[1] ? [+m[1], +m[2], +m[3]] : [+m[4], MONTHS[m[5].slice(0, 3).toLowerCase()], +m[6]];
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** Prima data che segue un'etichetta (sulla stessa riga o poco dopo, anche a capo). */
function dateAfter(text: string, label: RegExp, within = 120): string | null {
  const re = new RegExp(label.source, "gi");
  for (const m of text.matchAll(re)) {
    const tail = text.slice(m.index! + m[0].length, m.index! + m[0].length + within);
    const hit = tail.match(new RegExp(D, "i"));
    const iso = hit && toIsoDate(hit[0]);
    if (iso) return iso;
  }
  return null;
}

function amountAfter(text: string, label: RegExp, within = 60): number | null {
  for (const m of text.matchAll(new RegExp(label.source, "gi"))) {
    const tail = text.slice(m.index! + m[0].length, m.index! + m[0].length + within);
    const hit = tail.match(new RegExp(`(?:€|eur(?:o)?)?\\s*${AMOUNT}`, "i"));
    if (hit) {
      const v = parseItalianAmount(hit[1].replace(/[\s-]/g, ""));
      if (v !== null) return v;
    }
  }
  return null;
}

const TOTAL_LABELS = [
  /saldo\s+finale/, /totale\s+da\s+pagare/, /importo\s+da\s+pagare/, /totale\s+(?:della\s+)?(?:fattura|bolletta|documento|conto)/, /da\s+pagare/, /totale\s+dovuto/,
  /importo\s+(?:totale|complessivo)(?:\s+dovuto)?/, /importo\s+(?:della\s+)?rata\s+unica/, /rata\s+unica/, /totale\s+avviso/,
];
const DUE_LABELS = [/data\s+(?:di\s+)?scadenza/, /\bscad\.?(?=\s)/, /scadenza\s+(?:pagamento|fattura|bolletta)?/, /(?:da\s+pagare|pagare)\s+entro(?:\s+il)?/, /entro\s+il/];
const ISSUE_LABELS = [/emessa\s+il/, /data\s+(?:di\s+)?emissione/, /data\s+fattura/, /fattura\s+(?:n\.?|nr\.?|numero)\s*\S+\s+del/];

export function parseInvoice(text: string): Invoice {
  const t = text.replace(/ /g, " ");
  const known = PROVIDERS.find(([re]) => re.test(t.slice(0, 600))) ?? PROVIDERS.find(([re]) => re.test(t));

  const num = t.match(/fattura\s*(?:n\.?|n°|nr\.?|numero)\s*:?\s*([A-Z]{0,4}[\w/\-.]*\d[\w/\-]*)/i);

  let amount: number | null = null;
  for (const l of TOTAL_LABELS) if ((amount = amountAfter(t, l)) !== null) break;

  let dueDate: string | null = null;
  for (const l of DUE_LABELS) if ((dueDate = dateAfter(t, l, 60)) !== null) break;

  let issueDate: string | null = null;
  for (const l of ISSUE_LABELS) if ((issueDate = dateAfter(t, l, 160)) !== null) break;

  let periodFrom: string | null = null, periodTo: string | null = null;
  const per = new RegExp(`(?:dal\\s+)?(${D})\\s*(?:al|-|–)\\s*(${D})`, "i");
  for (const l of [/periodo\s+di\s+(?:fatturazione|riferimento|competenza)/, /periodo/]) {
    for (const m of t.matchAll(new RegExp(l.source, "gi"))) {
      const p = t.slice(m.index!, m.index! + 200).match(per);
      if (p) { periodFrom = toIsoDate(p[1]); periodTo = toIsoDate(p[2]); }
      if (periodFrom && periodTo) break;
    }
    if (periodFrom && periodTo) break;
  }

  // Voci di costo: "Descrizione   € 33,95   22%" (oppure "33,95 €"), con aliquota IVA in fondo alla riga.
  const items: InvoiceItem[] = [];
  const itemRe = new RegExp(`^(.*?[A-Za-zÀ-ú].*?)\\s{2,}(?:€\\s*)?${AMOUNT}\\s*(?:€)?\\s{2,}(\\d{1,2})\\s?%\\s*$`);
  for (const line of t.split("\n")) {
    const m = line.trim().match(itemRe);
    if (!m || /^(totale|imponibile|totali|codice iva)/i.test(m[1])) continue;
    const v = Number(m[2].replace(/\s/g, "").replace(/\./g, "").replace(",", "."));
    if (Number.isFinite(v)) items.push({ description: m[1].replace(/\s{2,}/g, " ").trim(), amount: v, vat: Number(m[3]) });
  }

  // F24 (TARI, IMU…): niente numero fattura, l'importo è il "saldo finale"; il codice tributo dice cos'è.
  const f24 = isF24(t);
  if (f24 && amount === null) amount = f24Amount(t);
  const tributo = f24 ? f24Tax(t) : null;

  return {
    provider: tributo?.[0] ?? known?.[1] ?? null,
    kind: tributo?.[1] ?? known?.[2] ?? null,
    invoiceNumber: num?.[1] ?? null,
    issueDate, dueDate, periodFrom, periodTo, amount, items,
  };
}

// Riga della sezione tributi locali di un F24: "EL   3944   H123 ... 2026   220 60" (anche senza la scritta F24,
// quando il modulo è un'immagine di sfondo e il PDF contiene solo i valori stampati sopra).
const F24_ROW = /^(?:E\s*L|E\s*R|R\s*G)\s+(?:39\d\d|TEFA|365[0-9])\b/im;
export const isF24 = (t: string) => /\bF24\b|modello\s+di\s+pagamento\s+unificato|delega\s+irrevocabile/i.test(t) || F24_ROW.test(t);

/** Codici tributo più comuni per la casa: TARI (3944/3950/TEFA TEFA), IMU (3912-3930). */
function f24Tax(t: string): [string, string] | null {
  if (/\b(3944|3945|3950|3951|TEFA)\b|\btari\b|rifiuti/i.test(t)) return ["TARI", "rifiuti"];
  if (/\b39(1[2-9]|2[0-9]|30)\b|\bimu\b/i.test(t)) return ["IMU", "altro"];
  return null;
}

/** Saldo dell'F24: dopo "SALDO FINALE" o "SALDO (A-B)"; altrimenti il primo "TOTALE" con importo. */
function f24Amount(t: string): number | null {
  for (const l of [/saldo\s+finale(?:\s+euro)?/, /saldo\s*\(\s*[a-z]\s*-\s*[a-z]\s*\)/, /totale\s+[a-z]\b/, /totale/]) {
    const v = amountAfter(t, l, 80);
    if (v !== null && v > 0) return v;
  }
  // Valori stampati nelle caselle del modulo: euro e centesimi separati da uno spazio ("231 60").
  // Il totale è la riga con il solo importo; altrimenti si sommano gli importi delle righe tributo.
  const boxed = (s: string) => { const m = s.match(/^(\d{1,3}(?:\.?\d{3})*) (\d{2})$/); return m ? Number(m[1]!.replace(/\./g, "")) + Number(m[2]) / 100 : null; };
  const lines = t.split("\n").map((l) => l.trim());
  for (const l of lines) { const v = boxed(l); if (v) return Math.round(v * 100) / 100; }
  let sum = 0;
  const seenRows = new Set<string>();
  for (const l of lines) {
    if (!F24_ROW.test(l) || seenRows.has(l)) continue; // il modulo ha due copie identiche (banca e contribuente)
    seenRows.add(l);
    const m = l.match(/\s(\d{1,3}(?:\.?\d{3})*)\s(\d{2})$/);
    if (m) sum += Number(m[1]!.replace(/\./g, "")) + Number(m[2]) / 100;
  }
  return sum > 0 ? Math.round(sum * 100) / 100 : null;
}

/** true se il testo sembra davvero una fattura/bolletta (e non, per esempio, un volantino). */
export function looksLikeInvoice(inv: Invoice, text?: string): boolean {
  return inv.amount !== null && (inv.invoiceNumber !== null || inv.dueDate !== null || (!!text && isF24(text)));
}
