/**
 * NAV giornaliero dei fondi da pagine pubbliche gratuite, senza chiavi:
 * - pagina del gestore (es. Fineco Asset Management): NAV con 3 decimali e data;
 * - FT Markets per ISIN (markets.ft.com): di solito un giorno più aggiornata, 2 decimali.
 * Funzioni pure, provate in test/funds.test.ts con estratti delle pagine reali.
 */
export interface Nav { isin: string; date: string; nav: number; source: "fam" | "ft" }

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
const num = (s: string) => { const n = Number(s.replace(/,/g, "")); return Number.isFinite(n) && n > 0 ? n : null; };

/** Pagina prodotto di finecoassetmanagement.com: "NAV Price 193.824 … NAV Date 2026-11-17". */
export function parseFamNav(html: string, isin: string): Nav | null {
  const t = text(html);
  const pageIsin = t.match(/ISIN\s+([A-Z]{2}[A-Z0-9]{10})/)?.[1];
  if (pageIsin && pageIsin !== isin) return null;
  const nav = num(t.match(/NAV Price\s+([\d.,]+)/)?.[1] ?? "");
  const date = t.match(/NAV Date\s+(\d{4}-\d{2}-\d{2})/)?.[1];
  const cur = t.match(/NAV Currency\s+([A-Z]{3})/)?.[1];
  if (!nav || !date || (cur && cur !== "EUR")) return null;
  return { isin, date, nav, source: "fam" };
}

const MONTHS: Record<string, string> = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };

/** Scheda FT Markets "summary?s=ISIN:EUR": "Price (EUR) 193.55 … as of Nov 18 2026". */
export function parseFtNav(html: string, isin: string): Nav | null {
  const t = text(html);
  const nav = num(t.match(/Price \(EUR\)\s+([\d.,]+)/)?.[1] ?? "");
  const d = t.match(/as of ([A-Z][a-z]{2}) (\d{1,2}) (\d{4})/);
  if (!nav || !d || !MONTHS[d[1]]) return null;
  return { isin, date: `${d[3]}-${MONTHS[d[1]]}-${d[2].padStart(2, "0")}`, nav, source: "ft" };
}

export const ftUrl = (isin: string) => `https://markets.ft.com/data/funds/tearsheet/summary?s=${isin}:EUR`;

/** Un NAV per data: a parità di data vince la pagina del gestore (più decimali). */
export function mergeNavs(navs: (Nav | null)[]): Nav[] {
  const by = new Map<string, Nav>();
  for (const n of navs) {
    if (!n) continue;
    const k = `${n.isin}|${n.date}`;
    const old = by.get(k);
    if (!old || (old.source !== "fam" && n.source === "fam")) by.set(k, n);
  }
  return [...by.values()].sort((a, b) => a.date.localeCompare(b.date));
}
