// Prova l'helper OAuth della Edge Function yrols-email-auth (codice senza API Deno, gira anche in Node).
import { test } from "node:test";
import assert from "node:assert/strict";
import { authUrl, exchangeCode, GMAIL_SCOPE, GoogleError, hasGmailScope, refreshAccessToken } from "../../../supabase/functions/_shared/google.ts";

const c = { clientId: "cid", clientSecret: "sec", redirectUri: "https://loriscuba.github.io/Yrols/callback/" };

test("consenso Google: solo lettura Gmail, offline, state passato", () => {
  const u = new URL(authUrl(c, "gm-abc"));
  assert.equal(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(u.searchParams.get("scope"), GMAIL_SCOPE);
  assert.equal(u.searchParams.get("scope"), "https://www.googleapis.com/auth/gmail.readonly");
  assert.equal(u.searchParams.get("access_type"), "offline");
  assert.equal(u.searchParams.get("state"), "gm-abc");
  assert.equal(u.searchParams.get("redirect_uri"), c.redirectUri);
  assert.equal(u.searchParams.get("client_secret"), null, "il secret non va mai nel browser");
});

test("scambio codice e refresh: parametri giusti, errore invalid_grant riconoscibile", async () => {
  const sent: URLSearchParams[] = [];
  const ok = (async (_u: string, init: RequestInit) => { sent.push(init.body as URLSearchParams); return Response.json({ access_token: "at", expires_in: 3599, refresh_token: "rt", scope: GMAIL_SCOPE }); }) as unknown as typeof fetch;
  const t = await exchangeCode(c, "code1", ok);
  assert.equal(t.refresh_token, "rt");
  assert.equal(sent[0]!.get("grant_type"), "authorization_code");
  assert.equal(sent[0]!.get("client_secret"), "sec");
  const bad = (async () => Response.json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, { status: 400 })) as unknown as typeof fetch;
  await assert.rejects(refreshAccessToken(c, "rt", bad), (e: unknown) => e instanceof GoogleError && e.code === "invalid_grant");
});

test("scope concesso", () => {
  assert.equal(hasGmailScope(`openid ${GMAIL_SCOPE}`), true);
  assert.equal(hasGmailScope("openid"), false);
  assert.equal(hasGmailScope(undefined), false);
});
