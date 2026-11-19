/**
 * Sicurezza dell'accesso online: secondo fattore (codice a 6 cifre) e uscita automatica dopo inattività.
 * La protezione vera è nel database: senza il codice (sessione "aal2") le regole RLS non mostrano nulla.
 */
import { supabase } from "./cloud";

/** Dopo questo tempo senza usare l'app bisogna rientrare con password e codice. */
export const IDLE_MINUTES = 30;
const IDLE_MS = IDLE_MINUTES * 60_000;
const KEY = "yrols-last-active";

const read = () => { try { return Number(localStorage.getItem(KEY)) || null; } catch { return null; } };
export function markActive(now = Date.now()) { try { localStorage.setItem(KEY, String(now)); } catch { /* ignora */ } }
export function clearActive() { try { localStorage.removeItem(KEY); } catch { /* ignora */ } }

/** Vero se l'ultima attività registrata è più vecchia del limite (senza registrazione: non scaduta). */
export function idleExpired(now = Date.now(), last = read()): boolean {
  return last !== null && now - last > IDLE_MS;
}

/** Esce da questo dispositivo (o da tutti) e dimentica l'ultima attività. */
export async function signOut(scope: "local" | "global" = "local") {
  clearActive();
  await supabase!.auth.signOut({ scope });
}

export type Gate = "out" | "enroll" | "verify" | "ok";

/** A che punto è l'accesso: senza sessione, da configurare il codice, da inserire il codice, completo. */
export async function gateFor(hasSession: boolean): Promise<Gate> {
  if (!hasSession) return "out";
  const sb = supabase!;
  const { data: aal, error } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error) throw error;
  if (aal.currentLevel === "aal2") return "ok";
  const { data: f, error: fe } = await sb.auth.mfa.listFactors();
  if (fe) throw fe;
  return f.totp.length > 0 ? "verify" : "enroll";
}

/** Messaggi in italiano per gli errori di Supabase Auth sul secondo fattore. */
export function mfaError(e: { message?: string; code?: string } | null): string {
  const m = e?.message ?? "";
  const c = e?.code ?? "";
  if (c === "mfa_verification_failed" || /invalid totp|invalid code/i.test(m)) return "Codice non valido. Controlla che l'ora del telefono sia giusta e riprova.";
  if (c === "mfa_challenge_expired" || /expired/i.test(m)) return "Il codice è scaduto: inseriscine uno nuovo.";
  if (c === "over_request_rate_limit" || /rate limit|too many/i.test(m)) return "Troppi tentativi: aspetta qualche minuto e riprova.";
  if (c === "mfa_totp_enroll_not_enabled") return "Il codice a 6 cifre non è attivo sul progetto Supabase.";
  if (c === "insufficient_aal") return "Prima inserisci il codice a 6 cifre.";
  return m || "Errore sconosciuto";
}

/** Toglie le registrazioni lasciate a metà (QR mostrato ma mai confermato), che bloccherebbero una nuova. */
export async function dropUnverified() {
  const { data } = await supabase!.auth.mfa.listFactors();
  for (const f of data?.all ?? []) if (f.status === "unverified") await supabase!.auth.mfa.unenroll({ factorId: f.id });
}

export const cleanCode = (s: string) => s.replace(/\D/g, "").slice(0, 6);
