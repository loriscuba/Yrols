/**
 * Regole su quando chiedere di nuovo l'accesso. Senza dipendenze, così si possono provare nei test.
 *
 * - Dispositivo normale: dopo IDLE_MINUTES senza usare l'app si esce (password + codice).
 * - Dispositivo ricordato: la sessione resta aperta per TRUST_DAYS dall'ultimo accesso completo. Se è attivo lo
 *   sblocco rapido (Face ID / impronta), dopo IDLE_MINUTES l'app si blocca e si riapre col dito o col viso.
 */
export const IDLE_MINUTES = 30;
export const TRUST_DAYS = 30;
const IDLE_MS = IDLE_MINUTES * 60_000;
export const TRUST_MS = TRUST_DAYS * 86_400_000;

export type DeviceTrust = { trustedUntil: number | null; quickUnlock: boolean };
export type Resume = "continue" | "unlock" | "signout";

/** Cosa fare quando l'app torna in primo piano o si riapre. */
export function onResume(now: number, lastActive: number | null, dev: DeviceTrust): Resume {
  if (dev.trustedUntil !== null) {
    if (now > dev.trustedUntil) return "signout";
    const idle = lastActive !== null && now - lastActive > IDLE_MS;
    return idle && dev.quickUnlock ? "unlock" : "continue";
  }
  return lastActive !== null && now - lastActive > IDLE_MS ? "signout" : "continue";
}
