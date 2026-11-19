/** Scalable Capital tramite il server MCP ufficiale, con la Edge Function Supabase "yrols-scalable". */
import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "./cloud";
export { parsePasted } from "./scalablePaste";

export interface ScalableStatus {
  status: "active" | "expired" | "pending";
  loggedInAt: string | null;
  lastSyncAt: string | null;
  expiresAt: string | null;
  lastError: string | null;
}
export interface Holding { accountId: string; isin: string; name: string | null; quantity: number | null; price: number | null; currency: string; value: number | null }
export interface ScalableSync { synced: boolean; reason?: "recent" | "not_connected" | "expired"; accounts?: number; holdings?: number; syncError?: string; error?: string }

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase!.functions.invoke("yrols-scalable", { body });
  if (error) {
    let msg = error.message;
    if (error instanceof FunctionsHttpError) {
      const j = await error.context.json().catch(() => null);
      if (j?.error) msg = j.error;
    }
    throw new Error(msg);
  }
  return data as T;
}

export async function scalableStatus(): Promise<ScalableStatus | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("yrols_scalable_status");
  if (error) throw new Error(error.message);
  return (data as ScalableStatus | null) ?? null;
}

export async function scalableHoldings(): Promise<Holding[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from("investment_holdings")
    .select("accountId:account_id,isin,name,quantity,price,currency,value").order("value", { ascending: false, nullsFirst: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as Holding[];
}

const PASTE_KEY = "yrols-scalable-paste";
const PASTE_TTL_MS = 30 * 60_000;

/** Accesso avviato da meno di 30 minuti: la scheda mostra il campo dove incollare l'indirizzo. */
export function pasteWaiting(): boolean {
  try { return Date.now() - Number(localStorage.getItem(PASTE_KEY) || 0) < PASTE_TTL_MS; } catch { return false; }
}
export function clearPasteWaiting() { try { localStorage.removeItem(PASTE_KEY); } catch { /* ignora */ } }

/**
 * Apre la pagina di accesso di Scalable in una nuova scheda (conferma nell'app Scalable).
 * Scalable rimanda poi a un indirizzo locale (http://127.0.0.1/...) che dà una pagina di errore:
 * il suo indirizzo contiene il codice da incollare in Yrols. Se il browser blocca la nuova scheda, apre qui.
 */
export async function startScalable() {
  const tab = window.open("", "_blank");
  try {
    const { url } = await call<{ url: string }>({ action: "start" });
    try { localStorage.setItem(PASTE_KEY, String(Date.now())); } catch { /* ignora */ }
    if (tab) tab.location.href = url; else window.location.assign(url);
  } catch (e) {
    tab?.close();
    throw e;
  }
}


export const completeScalable = (p: { state: string; code?: string; error?: string }) => call<ScalableSync>({ action: "complete", ...p });
export const syncScalable = (auto = false) => call<ScalableSync>({ action: "sync", auto });
export const disconnectScalable = () => call<{ ok: boolean }>({ action: "disconnect" });

/** Giorni interi mancanti alla scadenza stimata dell'accesso (7 giorni dal login). */
export const scalableDaysLeft = (s: ScalableStatus | null) =>
  s?.expiresAt ? Math.floor((Date.parse(s.expiresAt) - Date.now()) / 86_400_000) : null;
