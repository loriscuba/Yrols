/** Collegamento e rinnovo delle banche dall'app, tramite la Edge Function Supabase "yrols-bank-auth". */
import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "./cloud";

export interface BankOption { name: string; country: string; logo?: string; maxConsentDays?: number }
export interface CompleteResult {
  bankName: string; country: string; validUntil?: string; consentDays?: number;
  accounts?: { id: string; name: string | null; iban: string | null; currency: string }[];
  synced?: unknown; errors?: unknown[]; error?: string;
}

export const bankAuthAvailable = () => !!supabase;

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase!.functions.invoke("yrols-bank-auth", { body });
  if (error) {
    let msg = error.message;
    let status = 0;
    if (error instanceof FunctionsHttpError) {
      status = error.context.status;
      const j = await error.context.json().catch(() => null);
      if (j?.error) msg = j.error;
    }
    if (status === 503) msg = "Mancano le chiavi Enable Banking su Supabase (EB_APP_ID, EB_PRIVATE_KEY)";
    if (status === 400 && body.action === "complete") msg = "Collegamento scaduto o già completato: riprova da qui";
    throw new Error(msg);
  }
  return data as T;
}

export const listBanks = (country: string) => call<{ banks: BankOption[] }>({ action: "banks", country }).then((r) => r.banks);

/** Porta l'utente sulla pagina della banca per dare il consenso. */
export async function startBankAuth(opts: { bankName: string; country: string; consentDays?: number; replaces?: string }) {
  const { url } = await call<{ url: string }>({ action: "start", ...opts });
  window.location.assign(url);
}

export const completeBankAuth = (params: { state: string; code?: string; error?: string }) =>
  call<CompleteResult>({ action: "complete", ...params });

export const disconnectBank = (id: string) => call<{ ok: boolean }>({ action: "disconnect", id });
