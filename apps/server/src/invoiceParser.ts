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
  /totale\s+da\s+pagare/, /importo\s+da\s+pagare/, /totale\s+(?:della\s+)?(?:fattura|bolletta|documento|conto)/, /da\s+pagare/, /totale\s+dovuto/,
];
const DUE_LABELS = [/data\s+(?:di\s+)?scadenza/, /scadenza\s+(?:pagamento|fattura|bolletta)?/, /(?:da\s+pagare|pagare)\s+entro(?:\s+il)?/, /entro\s+il/];
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

  return {
    provider: known?.[1] ?? null,
    kind: known?.[2] ?? null,
    invoiceNumber: num?.[1] ?? null,
    issueDate, dueDate, periodFrom, periodTo, amount, items,
  };
}

/** true se il testo sembra davvero una fattura/bolletta (e non, per esempio, un volantino). */
export function looksLikeInvoice(inv: Invoice): boolean {
  return inv.amount !== null && (inv.invoiceNumber !== null || inv.dueDate !== null);
}
