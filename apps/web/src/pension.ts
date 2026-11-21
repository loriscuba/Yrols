/**
 * Fondo pensione: i file scaricati dall'area riservata del fondo si leggono nel browser
 * (Excel "importi versati" e PDF "sintesi posizione") e si salvano in Supabase con yrols_pension_import.
 */
import { supabase } from "./cloud";
import { readXlsxRows } from "../../server/src/xlsxRead.ts";
import { parseContributions, parseSintesi, type PensionContribution, type PensionPosition } from "../../server/src/pension.ts";
import { pdfToText, type GetDocument } from "../../server/src/pdfText.ts";

export type { PensionContribution, PensionPosition };
// Un solo fondo pensione; il nome vero sta nel database (repository pubblico).
export const PENSION_ID = "fondo-pensione";
const PENSION_NAME = "Fondo pensione";

export interface PensionFund {
  id: string; name: string; comparto: string | null; paid: number; total: number | null; totalDate: string | null; estimated: boolean;
  units: number | null; unitValue: number | null; unitValueDate: string | null; invested: number | null; pending: number;
  result: number | null; allocation: Record<string, number> | null; pdfDate: string | null; pdfTotal: number | null; pdfPaid: number | null;
  excelAt: string | null; pdfAt: string | null;
}
export interface PensionHistory { date: string; total: number; paid: number; estimated: boolean }

const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export async function loadPension(): Promise<{ fund: PensionFund | null; contributions: PensionContribution[]; history: PensionHistory[] }> {
  const empty = { fund: null, contributions: [], history: [] };
  if (!supabase) return empty;
  const [f, c, h] = await Promise.all([
    supabase.from("pension_funds").select("id,name,comparto,paid,total,totalDate:total_date,estimated,units,unitValue:unit_value,unitValueDate:unit_value_date,invested,pending,result,allocation,pdfDate:pdf_date,pdfTotal:pdf_total,pdfPaid:pdf_paid,excelAt:excel_at,pdfAt:pdf_at").eq("id", PENSION_ID).maybeSingle(),
    supabase.from("pension_contributions").select("year,period,total,employee,employer,tfr,voluntary,tfrSilent:tfr_silent,tfrRevaluation:tfr_revaluation,welfare,transfer,status,kind").eq("fund_id", PENSION_ID).order("seq"),
    supabase.from("pension_history").select("date,total,paid,estimated").eq("fund_id", PENSION_ID).order("date"),
  ]);
  // Migrazione non ancora applicata: nessun fondo, senza errori in pagina.
  if (f.error || !f.data) return empty;
  const r = f.data;
  const fund: PensionFund = {
    ...r, paid: Number(r.paid), total: n(r.total), units: n(r.units), unitValue: n(r.unitValue), invested: n(r.invested), pending: Number(r.pending),
    result: n(r.result), pdfTotal: n(r.pdfTotal), pdfPaid: n(r.pdfPaid),
  } as PensionFund;
  const nums = ["total", "employee", "employer", "tfr", "voluntary", "tfrSilent", "tfrRevaluation", "welfare", "transfer"] as const;
  const contributions = (c.data ?? []).map((x) => {
    const o = { ...x } as Record<string, unknown>;
    for (const k of nums) o[k] = Number(o[k]);
    return o as unknown as PensionContribution;
  });
  const history = (h.data ?? []).map((x) => ({ ...x, total: Number(x.total), paid: Number(x.paid) })) as PensionHistory[];
  return { fund, contributions, history };
}

async function readPdfText(file: File) {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfToText(pdfjs.getDocument as unknown as GetDocument, new Uint8Array(await file.arrayBuffer()));
}

export interface PensionFiles { contributions?: PensionContribution[]; position?: PensionPosition; names: string[] }

/** Riconosce i file dal contenuto (zip = Excel, %PDF = sintesi) e li legge. */
export async function readPensionFiles(files: File[]): Promise<PensionFiles> {
  const out: PensionFiles = { names: [] };
  for (const file of files) {
    const bytes = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    const magic = String.fromCharCode(...bytes);
    if (magic.startsWith("PK")) {
      out.contributions = parseContributions(await readXlsxRows(new Uint8Array(await file.arrayBuffer())));
    } else if (magic === "%PDF") {
      let text: string;
      try { text = await readPdfText(file); } catch { throw new Error(`Non riesco a leggere il PDF ${file.name} (protetto da password o scansione?)`); }
      out.position = parseSintesi(text);
    } else {
      throw new Error(`${file.name}: carica l'Excel degli importi versati (.xlsx) o il PDF della sintesi posizione`);
    }
    out.names.push(file.name);
  }
  return out;
}

export interface ImportResult { contributions: number; paid: number; total: number; estimated: boolean; date: string }
export async function importPension(data: PensionFiles): Promise<ImportResult> {
  const { data: r, error } = await supabase!.rpc("yrols_pension_import", {
    fund: PENSION_ID, data: { name: PENSION_NAME, contributions: data.contributions, position: data.position },
  });
  if (error) throw new Error(error.message);
  return r as ImportResult;
}

/** Rendimento in percentuale sul versato (null se manca il dato). */
export const pensionGainPct = (f: PensionFund) =>
  f.result !== null && f.pdfPaid ? (f.result / f.pdfPaid) * 100 : null;
