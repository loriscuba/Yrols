/** Collegamento Gmail dall'app (Google OAuth in sola lettura), tramite la Edge Function "yrols-email-auth". */
import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "./cloud";

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase!.functions.invoke("yrols-email-auth", { body });
  if (error) {
    let msg = error.message;
    let status = 0;
    if (error instanceof FunctionsHttpError) {
      status = error.context.status;
      const j = await error.context.json().catch(() => null);
      if (j?.error) msg = j.error;
    }
    if (status === 503) msg = "Mancano le credenziali Google su Supabase (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)";
    if (status === 404 && body.action !== "token") msg = "La funzione yrols-email-auth non è ancora pubblicata su Supabase";
    throw new Error(msg);
  }
  return data as T;
}

/** Porta l'utente sulla pagina di consenso di Google. */
export async function startGmailAuth(loginHint?: string) {
  const { url } = await call<{ url: string }>({ action: "start", loginHint });
  window.location.assign(url);
}

export const completeGmailAuth = (params: { state: string; code?: string; error?: string }) =>
  call<{ email?: string; error?: string }>({ action: "complete", ...params });

export const disconnectGmail = () => call<{ ok: boolean }>({ action: "disconnect" });
