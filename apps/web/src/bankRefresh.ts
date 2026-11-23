/**
 * Aggiornamento dei movimenti con l'utente presente: all'apertura dell'app (al massimo ogni 30 minuti)
 * e dal pulsante "Aggiorna ora" (al massimo ogni 2 minuti). Lo stesso limite è applicato dalla Edge Function.
 * Una sola lettura alla volta: le richieste ripetute riusano quella in corso.
 */
import { useSyncExternalStore } from "react";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "./cloud";
import { syncScalable, type ScalableSync } from "./scalable";

export const AUTO_GAP_MS = 30 * 60_000;
const LAST_KEY = "yrols-bank-refresh";
export const DATA_CHANGED = "yrols:data-changed";

export type RefreshState =
  | { status: "idle" }
  | { status: "running"; auto: boolean }
  | { status: "done" | "error" | "info"; auto: boolean; text: string; at: number };

interface RefreshResponse {
  refreshed: boolean;
  reason?: "recent" | "no_accounts" | "bank_error";
  retryInSeconds?: number;
  lastSync?: string | null;
  newTransactions?: number;
  errors?: { bank: string; message: string }[];
}

let state: RefreshState = { status: "idle" };
let inFlight: Promise<RefreshState> | null = null;
const listeners = new Set<() => void>();
const set = (s: RefreshState) => { state = s; listeners.forEach((l) => l()); };

const readLast = () => { try { return Number(localStorage.getItem(LAST_KEY)) || 0; } catch { return 0; } };
const writeLast = (t: number) => { try { localStorage.setItem(LAST_KEY, String(t)); } catch { /* ignora */ } };

export const refreshAvailable = () => !!supabase;

/** Testo per l'utente dal risultato della funzione. */
export function describe(r: RefreshResponse): { kind: "done" | "error" | "info"; text: string } {
  const errs = (r.errors ?? []).map((e) => `${e.bank}: ${e.message}`).join("; ");
  if (r.refreshed) {
    const n = r.newTransactions;
    const head = n === undefined ? "Movimenti aggiornati" : n === 0 ? "Nessun movimento nuovo" : n === 1 ? "1 movimento nuovo" : `${n} movimenti nuovi`;
    return errs ? { kind: "error", text: `${head}. ${errs}` } : { kind: "done", text: head };
  }
  if (r.reason === "recent") {
    const min = Math.max(1, Math.ceil((r.retryInSeconds ?? 60) / 60));
    return { kind: "info", text: `Movimenti già aggiornati da poco: riprova tra ${min} ${min === 1 ? "minuto" : "minuti"}` };
  }
  if (r.reason === "no_accounts") return { kind: "info", text: "Nessuna banca collegata da aggiornare" };
  return { kind: "error", text: errs ? `Aggiornamento non riuscito. ${errs}` : "Aggiornamento non riuscito" };
}

/** Nota su Scalable da aggiungere al messaggio, solo se c'è qualcosa da dire. */
export function scalableNote(sc: ScalableSync): { text: string; error: boolean } | null {
  if (sc.reason === "expired") return { text: "Scalable: accesso da rinnovare dalla pagina Banche", error: true };
  // Gli altri errori (Scalable non collegato, server non raggiungibile) restano nella scheda Scalable della pagina Banche.
  if (sc.synced) return { text: "Scalable aggiornato", error: false };
  return null;
}

export function refreshBanks({ auto = false } = {}): Promise<RefreshState> {
  if (!supabase) return Promise.resolve(state);
  if (inFlight) return inFlight;
  if (auto && Date.now() - readLast() < AUTO_GAP_MS) return Promise.resolve(state);
  set({ status: "running", auto });
  inFlight = (async (): Promise<RefreshState> => {
    try {
      // Scalable (server MCP) in parallelo alle banche: un suo errore non blocca i movimenti.
      const scalable = syncScalable(auto).catch((e: Error): ScalableSync => ({ synced: false, error: e.message }));
      const { data, error } = await supabase!.functions.invoke("yrols-bank-auth", { body: { action: "refresh", auto } });
      if (error) {
        let msg = error.message;
        if (error instanceof FunctionsHttpError) {
          const j = await error.context.json().catch(() => null);
          if (j?.error) msg = j.error;
        }
        throw new Error(msg);
      }
      const r = data as RefreshResponse;
      writeLast(r.refreshed ? Date.now() : r.lastSync ? Date.parse(r.lastSync) : Date.now());
      const sc = await scalable;
      if (r.refreshed || sc.synced) dispatchEvent(new Event(DATA_CHANGED));
      const d = describe(r);
      const note = scalableNote(sc);
      if (!note) return { status: d.kind, auto, text: d.text, at: Date.now() };
      return { status: note.error ? "error" : d.kind, auto, text: `${d.text}. ${note.text}`, at: Date.now() };
    } catch (e) {
      return { status: "error", auto, text: `Aggiornamento non riuscito: ${(e as Error).message}`, at: Date.now() };
    }
  })().then((s) => { set(s); return s; }).finally(() => { inFlight = null; });
  return inFlight;
}

export function useBankRefresh(): RefreshState {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state);
}
