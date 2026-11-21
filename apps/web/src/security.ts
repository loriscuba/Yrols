/**
 * Sicurezza dell'accesso online: secondo fattore (codice a 6 cifre), dispositivo ricordato, sblocco rapido
 * e uscita automatica dopo inattività sui dispositivi non ricordati.
 * La protezione vera è nel database: senza il codice (sessione "aal2") le regole RLS non mostrano nulla.
 */
import { supabase } from "./cloud";
import { onResume, TRUST_MS, type DeviceTrust, type Resume } from "./lockPolicy";

export { IDLE_MINUTES, TRUST_DAYS } from "./lockPolicy";
const KEY = "yrols-last-active";
const TRUST = "yrols-trusted-until";
const UNLOCK = "yrols-quick-unlock";

const get = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* ignora */ } };
const read = () => Number(get(KEY)) || null;
export function markActive(now = Date.now()) { set(KEY, String(now)); }
export function clearActive() { set(KEY, null); }

/** Stato di questo dispositivo: ricordato (fino a quando) e sblocco rapido attivo. */
export function deviceTrust(): DeviceTrust {
  return { trustedUntil: Number(get(TRUST)) || null, quickUnlock: !!get(UNLOCK) };
}
/** Ricorda questo dispositivo per TRUST_DAYS da adesso (chiamato dopo un accesso completo). */
export function trustDevice(now = Date.now()) { set(TRUST, String(now + TRUST_MS)); }
export function forgetDevice() { set(TRUST, null); }

/** Cosa fare adesso: continuare, chiedere lo sblocco rapido o uscire. */
export function resumeAction(now = Date.now()): Resume {
  return onResume(now, read(), deviceTrust());
}

/** Esce da questo dispositivo (o da tutti), dimentica l'ultima attività e smette di ricordare il dispositivo. */
export async function signOut(scope: "local" | "global" = "local") {
  clearActive();
  forgetDevice();
  await supabase!.auth.signOut({ scope });
}

/* ---- Sblocco rapido con Face ID / Touch ID / impronta (WebAuthn, resta sul dispositivo) ---- */

const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const challenge = () => crypto.getRandomValues(new Uint8Array(32));

/** Vero se il dispositivo ha un sensore (viso, impronta o PIN del sistema) utilizzabile dal browser. */
export async function quickUnlockAvailable(): Promise<boolean> {
  try {
    return !!window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch { return false; }
}

/** Registra il sensore del dispositivo per lo sblocco rapido. */
export async function enableQuickUnlock(email: string) {
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: challenge(),
      rp: { name: "Yrols" },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: email || "Yrols", displayName: "Yrols" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "discouraged" },
      timeout: 60_000,
    },
  }) as PublicKeyCredential | null;
  if (!cred) throw new Error("Registrazione annullata");
  set(UNLOCK, b64(cred.rawId));
}
export function disableQuickUnlock() { set(UNLOCK, null); }

/** Chiede viso/impronta. Vero se riconosciuto. */
export async function quickUnlock(): Promise<boolean> {
  const id = get(UNLOCK);
  if (!id) return false;
  try {
    const r = await navigator.credentials.get({
      publicKey: { challenge: challenge(), allowCredentials: [{ type: "public-key", id: unb64(id) }], userVerification: "required", timeout: 60_000 },
    });
    if (r) markActive();
    return !!r;
  } catch { return false; }
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
