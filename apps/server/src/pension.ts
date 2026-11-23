/**
 * Fondo pensione negoziale: lettura dei due file che l'area riservata del fondo fa scaricare.
 * - Excel "importi versati": un contributo per riga (periodo, anno, totale e ripartizione), storia completa.
 * - PDF "sintesi posizione aderente": totale posizione, quote, valore quota, rendimento.
 * L'Excel non contiene quote né valore quota: il controvalore esatto arriva solo dal PDF.
 * Codice puro, usato dal browser (pagina Fondo pensione) e dai test.
 */
import type { Cell } from "./xlsxRead.ts";

export interface PensionContribution {
  year: number; period: number; total: number;
  employee: number; employer: number; tfr: number; voluntary: number; tfrSilent: number; tfrRevaluation: number;
  welfare: number; transfer: number; status: string | null; kind: string | null;
}

export interface PensionPosition {
  date: string;                 // YYYY-MM-DD, data della sintesi
  paid: number | null;          // importi versati
  benefits: number;             // prestazioni godute
  result: number | null;        // risultato della gestione
  total: number;                // totale posizione
  comparto: string | null;
  units: number | null;         // quote in essere
  unitValue: number | null;     // valore quota
  unitValueDate: string | null; // data dell'ultima quota valorizzata
  invested: number | null;      // controvalore delle quote
  pending: number;              // importi in attesa di investimento
  allocation: Record<string, number>;
}

const norm = (s: unknown) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]/g, "");

/** Numero da cella Excel (numero, "1.234,56" o "1234.56"). */
export function num(v: Cell | undefined): number {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = v.replace(/[€\s]/g, "");
  const n = Number(/,\d{1,2}$/.test(s) ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}
const cents = (n: number) => Math.round(n * 100) / 100;

const COLUMNS: Record<string, keyof PensionContribution> = {
  periodo: "period", anno: "year", totale: "total", aderente: "employee", azienda: "employer", tfr: "tfr",
  volontario: "voluntary", tfrsilente: "tfrSilent", rivalutazionecontributotfr: "tfrRevaluation", welfare: "welfare",
  trasferimentoreintegro: "transfer", statocontributo: "status", tipologia: "kind",
};

/** Contributi dall'Excel "importi versati". Lancia un errore leggibile se il file non è quello giusto. */
export function parseContributions(rows: Cell[][]): PensionContribution[] {
  const h = rows.findIndex((r) => r.some((c) => norm(c) === "periodo") && r.some((c) => norm(c) === "totale"));
  if (h < 0) throw new Error("Questo Excel non sembra l'elenco degli importi versati (mancano le colonne Periodo e Totale)");
  const cols = new Map<keyof PensionContribution, number>();
  rows[h]!.forEach((c, i) => {
    const k = COLUMNS[norm(c)] ?? (norm(c).startsWith("trasferimento") ? "transfer" : norm(c).startsWith("rivalutazione") ? "tfrRevaluation" : undefined);
    if (k && !cols.has(k)) cols.set(k, i);
  });
  if (!cols.has("year")) throw new Error("Nell'Excel manca la colonna Anno");
  const get = (r: Cell[], k: keyof PensionContribution) => (cols.has(k) ? r[cols.get(k)!] : null);
  const out: PensionContribution[] = [];
  for (const r of rows.slice(h + 1)) {
    const year = Math.trunc(num(get(r, "year"))), period = Math.trunc(num(get(r, "period")));
    if (!year || !r.some((c) => c !== null && c !== "")) continue;
    const text = (k: keyof PensionContribution) => { const v = get(r, k); return v === null || v === "" ? null : String(v).trim(); };
    out.push({
      year, period, total: cents(num(get(r, "total"))),
      employee: cents(num(get(r, "employee"))), employer: cents(num(get(r, "employer"))), tfr: cents(num(get(r, "tfr"))),
      voluntary: cents(num(get(r, "voluntary"))), tfrSilent: cents(num(get(r, "tfrSilent"))), tfrRevaluation: cents(num(get(r, "tfrRevaluation"))),
      welfare: cents(num(get(r, "welfare"))), transfer: cents(num(get(r, "transfer"))), status: text("status"), kind: text("kind"),
    });
  }
  if (!out.length) throw new Error("L'Excel degli importi versati è vuoto");
  return out;
}

/** Versato per tipo, con le stesse voci della sintesi del fondo. */
export function paidBreakdown(list: PensionContribution[]) {
  const sum = (f: (c: PensionContribution) => number) => cents(list.reduce((s, c) => s + f(c), 0));
  return {
    total: sum((c) => c.total),
    employee: sum((c) => c.employee + c.voluntary),          // contributi lavoratore
    employer: sum((c) => c.employer),                       // contributi datore di lavoro
    tfr: sum((c) => c.tfr + c.tfrSilent + c.tfrRevaluation),
    transfer: sum((c) => c.transfer),                       // trasferimenti da altro fondo e reintegri
    welfare: sum((c) => c.welfare),                         // premio di produzione
  };
}

/** Contributi non ancora trasformati in quote (stato diverso da "Quotato"). */
export const isPending = (c: PensionContribution) => !!c.status && norm(c.status) !== "quotato";

const AMOUNT = /-?\d{1,3}(?:\.\d{3})*,\d{2,3}(?!\d)/g;
const itNum = (s: string) => Number(s.replace(/\./g, "").replace(",", "."));
const isoDate = (d: string) => { const [g, m, y] = d.split("/"); return `${y}-${m}-${g}`; };

/** Sintesi posizione individuale (testo del PDF riga per riga, come da pdfToText). */
export function parseSintesi(text: string): PensionPosition {
  const lines = text.split("\n").map((l) => l.trim());
  if (!/sintesi posizione individuale/i.test(text)) throw new Error("Questo PDF non è la sintesi della posizione del fondo pensione");
  const date = text.match(/(?:maturato|posizione individuale) al (\d{2}\/\d{2}\/\d{4})/i)?.[1];
  const head = lines.findIndex((l) => /importi versati/i.test(l) && /totale posizione/i.test(l));
  const figures = head >= 0 ? (lines.slice(head + 1).find((l) => (l.match(AMOUNT) ?? []).length >= 4)?.match(AMOUNT) ?? []).map(itNum) : [];
  const totalLine = lines.find((l) => /^posizione individuale al \d/i.test(l) && l.match(AMOUNT));
  const total = figures[3] ?? (totalLine ? itNum(totalLine.match(AMOUNT)!.at(-1)!) : NaN);
  if (!date || !Number.isFinite(total)) throw new Error("Nel PDF non trovo il totale della posizione");

  // Composizione: "DINAMICO   1.066,730   30,91   32.972,62 €" (un comparto per riga).
  const comp = lines.findIndex((l) => /^comparto\b/i.test(l) && /quote in essere/i.test(l));
  let comparto: string | null = null, units: number | null = null, unitValue: number | null = null, invested: number | null = null;
  if (comp >= 0) {
    for (const l of lines.slice(comp + 1)) {
      if (/^(importo in attesa|posizione individuale)/i.test(l)) break;
      const m = l.match(/^([A-Za-zÀ-ÿ ]+?)\s{2,}(\d{1,3}(?:\.\d{3})*,\d{1,6})\s+(\d+,\d+)\s+(\d{1,3}(?:\.\d{3})*,\d{2})/);
      if (!m) continue;
      const name = m[1]!.trim();
      comparto = comparto ? `${comparto}, ${name}` : name;
      units = (units ?? 0) + itNum(m[2]!);
      unitValue = itNum(m[3]!);
      invested = cents((invested ?? 0) + itNum(m[4]!));
    }
  }
  const pendingLine = lines.find((l) => /^importo in attesa di investimento/i.test(l));
  const pending = pendingLine?.match(AMOUNT) ? itNum(pendingLine.match(AMOUNT)!.at(-1)!) : 0;
  // Data dell'ultima quota: la più recente tra le operazioni recenti.
  const op = lines.findIndex((l) => /dettaglio operazioni recenti/i.test(l));
  let unitValueDate: string | null = null;
  if (op >= 0) {
    for (const l of lines.slice(op + 1, op + 30)) {
      if (/^importi in attesa/i.test(l)) break;
      const d = l.match(/\b(\d{2}\/\d{2}\/\d{4})\b/)?.[1];
      if (d && (!unitValueDate || isoDate(d) > unitValueDate)) unitValueDate = isoDate(d);
    }
  }
  const allocation: Record<string, number> = {};
  for (const m of text.matchAll(/(\d{1,3},\d{1,2})%\s+(Obbligazioni|Azioni|Liquidit[àa])/g)) allocation[m[2]!.replace(/a$/, "à")] = itNum(m[1]!);

  return {
    date: isoDate(date), paid: figures[0] ?? null, benefits: figures[1] ?? 0, result: figures[2] ?? null, total,
    comparto: comparto ? comparto[0]!.toUpperCase() + comparto.slice(1).toLowerCase() : null,
    units: units === null ? null : Math.round(units * 1000) / 1000, unitValue, unitValueDate, invested, pending, allocation,
  };
}
