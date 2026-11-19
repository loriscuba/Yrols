/** Scalable Capital tramite il server MCP ufficiale, con la Edge Function Supabase "yrols-scalable". */
import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "./cloud";

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

/** Porta l'utente sulla pagina di accesso di Scalable (conferma nell'app Scalable), poi si torna su /banche. */
export async function startScalable() {
  const { url } = await call<{ url: string }>({ action: "start" });
  window.location.assign(url);
}

export const completeScalable = (p: { state: string; code?: string; error?: string }) => call<ScalableSync>({ action: "complete", ...p });
export const syncScalable = (auto = false) => call<ScalableSync>({ action: "sync", auto });
export const disconnectScalable = () => call<{ ok: boolean }>({ action: "disconnect" });

/** Giorni interi mancanti alla scadenza stimata dell'accesso (7 giorni dal login). */
export const scalableDaysLeft = (s: ScalableStatus | null) =>
  s?.expiresAt ? Math.floor((Date.parse(s.expiresAt) - Date.now()) / 86_400_000) : null;
