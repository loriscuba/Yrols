// Google OAuth per Gmail in sola lettura (Edge Functions Supabase).
// Nessuna dipendenza: solo fetch, così è testabile con un fetch finto.

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";

export class GoogleError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

export interface GoogleClient { clientId: string; clientSecret: string; redirectUri: string }
export interface TokenResponse { access_token: string; expires_in: number; refresh_token?: string; scope?: string }

/** Indirizzo della pagina di consenso Google: sola lettura, refresh token (offline) sempre riemesso. */
export function authUrl(c: GoogleClient, state: string, loginHint?: string): string {
  const u = new URL(AUTH_URL);
  u.searchParams.set("client_id", c.clientId);
  u.searchParams.set("redirect_uri", c.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GMAIL_SCOPE);
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "false");
  u.searchParams.set("state", state);
  if (loginHint) u.searchParams.set("login_hint", loginHint);
  return u.toString();
}

async function tokenRequest(params: Record<string, string>, f: typeof fetch): Promise<TokenResponse> {
  const res = await f(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
  const body = await res.json().catch(() => ({})) as Record<string, string>;
  if (!res.ok) throw new GoogleError(`Google: ${body.error_description || body.error || res.status}`, res.status, body.error);
  return body as unknown as TokenResponse;
}

export const exchangeCode = (c: GoogleClient, code: string, f: typeof fetch = fetch) =>
  tokenRequest({ code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: c.redirectUri, grant_type: "authorization_code" }, f);

export const refreshAccessToken = (c: GoogleClient, refreshToken: string, f: typeof fetch = fetch) =>
  tokenRequest({ refresh_token: refreshToken, client_id: c.clientId, client_secret: c.clientSecret, grant_type: "refresh_token" }, f);

export async function gmailAddress(accessToken: string, f: typeof fetch = fetch): Promise<string> {
  const res = await f(PROFILE_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new GoogleError(`Gmail: profilo non leggibile (${res.status})`, res.status);
  return ((await res.json()) as { emailAddress: string }).emailAddress;
}

/** Revoca il permesso su Google (anche il refresh token smette di funzionare). */
export async function revoke(token: string, f: typeof fetch = fetch): Promise<void> {
  const res = await f(REVOKE_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) });
  if (!res.ok && res.status !== 400) throw new GoogleError(`Google: revoca non riuscita (${res.status})`, res.status);
}

/** Lo scope concesso contiene la lettura Gmail? (l'utente può togliere la spunta nella pagina di Google) */
export const hasGmailScope = (scope?: string) => (scope ?? "").split(" ").includes(GMAIL_SCOPE);
