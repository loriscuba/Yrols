// Senza dipendenze dal browser: testato in apps/server/test/scalable.test.ts.

/** Legge code, state ed eventuale errore dall'indirizzo incollato (anche senza "http://"). */
export function parsePasted(text: string): { state: string; code?: string; error?: string } | null {
  const raw = text.trim();
  if (!raw) return null;
  let q: URLSearchParams;
  try { q = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`).searchParams; } catch { return null; }
  const state = q.get("state");
  if (!state || !state.startsWith("sc-")) return null;
  const code = q.get("code") ?? undefined, error = q.get("error_description") ?? q.get("error") ?? undefined;
  return code || error ? { state, code, error } : null;
}
