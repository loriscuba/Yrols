/** Fondi senza API (es. PAC Fineco): valore aggiornato ogni giorno dal NAV pubblico (Action "Fondi"). */
import { supabase } from "./cloud";

export interface Fund {
  id: string; isin: string; name: string; bankName: string; quantity: number; cost: number;
  pacAmount: number; pacDay: number | null; pacPaid: number; pacTotal: number | null; pacNext: string | null;
  lastNav: number | null; lastNavDate: string | null;
}
export interface PacPurchase { fundId: string; dueDate: string; navDate: string; nav: number; amount: number; quantity: number }

const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export async function listFunds(): Promise<{ funds: Fund[]; purchases: PacPurchase[] }> {
  if (!supabase) return { funds: [], purchases: [] };
  const [f, p] = await Promise.all([
    supabase.from("funds").select("id,isin,name,bankName:bank_name,quantity,cost,pacAmount:pac_amount,pacDay:pac_day,pacPaid:pac_paid,pacTotal:pac_total,pacNext:pac_next,lastNav:last_nav,lastNavDate:last_nav_date").order("name"),
    supabase.from("fund_pac_purchases").select("fundId:fund_id,dueDate:due_date,navDate:nav_date,nav,amount,quantity").order("due_date", { ascending: false }).limit(12),
  ]);
  // Migrazione non ancora applicata: nessun fondo, senza errori in pagina.
  if (f.error) return { funds: [], purchases: [] };
  const funds = (f.data ?? []).map((r) => ({ ...r, quantity: Number(r.quantity), cost: Number(r.cost), pacAmount: Number(r.pacAmount), lastNav: n(r.lastNav) })) as Fund[];
  const purchases = (p.data ?? []).map((r) => ({ ...r, nav: Number(r.nav), amount: Number(r.amount), quantity: Number(r.quantity) })) as PacPurchase[];
  return { funds, purchases };
}

export interface FundEdit { quantity?: number; cost?: number; pacAmount?: number; pacDay?: number; pacPaid?: number; pacTotal?: number }
export async function updateFund(id: string, data: FundEdit) {
  const { error } = await supabase!.rpc("yrols_fund_update", { fund: id, data });
  if (error) throw new Error(error.message);
}

/** Valore, guadagno e prezzo medio di carico. */
export function fundFigures(f: Fund) {
  const value = f.lastNav === null ? null : Math.round(f.quantity * f.lastNav * 100) / 100;
  const gain = value === null ? null : Math.round((value - f.cost) * 100) / 100;
  return { value, gain, gainPct: gain !== null && f.cost > 0 ? (gain / f.cost) * 100 : null, avgPrice: f.quantity > 0 ? f.cost / f.quantity : null };
}
