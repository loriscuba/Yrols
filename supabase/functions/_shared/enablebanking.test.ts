// deno test supabase/functions/_shared/enablebanking.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createJwt, normalizeTransaction, psuHeaders, refreshWait } from "./enablebanking.ts";

const b64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const toPem = (der: ArrayBuffer, label: string) =>
  `-----BEGIN ${label}-----\n${btoa(String.fromCharCode(...new Uint8Array(der))).replace(/.{64}/g, "$&\n")}\n-----END ${label}-----\n`;

async function keyPair() {
  return await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
}

async function verify(token: string, pub: CryptoKey) {
  const [h, p, s] = token.split(".");
  return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pub, b64(s!), new TextEncoder().encode(`${h}.${p}`));
}

Deno.test("JWT RS256 con chiave PKCS#8", async () => {
  const kp = await keyPair();
  const pem = toPem(await crypto.subtle.exportKey("pkcs8", kp.privateKey), "PRIVATE KEY");
  const token = await createJwt("app-1", pem);
  const header = JSON.parse(new TextDecoder().decode(b64(token.split(".")[0]!)));
  const payload = JSON.parse(new TextDecoder().decode(b64(token.split(".")[1]!)));
  assertEquals(header, { typ: "JWT", alg: "RS256", kid: "app-1" });
  assertEquals(payload.aud, "api.enablebanking.com");
  assert(await verify(token, kp.publicKey));
});

Deno.test("JWT RS256 con chiave PKCS#1 (BEGIN RSA PRIVATE KEY) e \\n letterali", async () => {
  const kp = await keyPair();
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  // Estrae la RSAPrivateKey dall'OCTET STRING finale del PKCS#8 (struttura fissa per RSA 2048).
  const idx = pkcs8.indexOf(0x04, 22);
  const lenBytes = pkcs8[idx + 1]! & 0x7f;
  const pkcs1 = pkcs8.slice(idx + 2 + lenBytes);
  const pem = toPem(pkcs1.buffer, "RSA PRIVATE KEY").replace(/\n/g, "\\n");
  assert(await verify(await createJwt("app-2", pem), kp.publicKey));
});

Deno.test("id sintetico identico al connettore Node", async () => {
  const t = await normalizeTransaction({
    transaction_amount: { currency: "EUR", amount: "10.50" }, credit_debit_indicator: "DBIT", status: "BOOK",
    booking_date: "2026-10-01", creditor: { name: "Enel" }, remittance_information: ["SDD"],
  }, "acc-1");
  // Valore calcolato con connectors/enable-banking/dist/src/normalize.js
  assertEquals(t.id, "h_e09ed67fb1b675fd2f050ffd2afd390a");
  assertEquals(t.amount, -10.5);
  assertEquals(t.counterparty, "Enel");
});

Deno.test("intestazioni PSU dalla richiesta del browser", () => {
  const req = new Request("https://x.supabase.co/functions/v1/yrols-bank-auth", {
    method: "POST",
    headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1", "user-agent": "Mozilla/5.0 Test", "accept-language": "it-IT,it;q=0.9", referer: "https://loriscuba.github.io/Yrols/" },
  });
  assertEquals(psuHeaders(req), {
    "Psu-Ip-Address": "203.0.113.7",
    "Psu-User-Agent": "Mozilla/5.0 Test",
    "Psu-Referer": "https://loriscuba.github.io/Yrols/",
    "Psu-Accept-language": "it-IT,it;q=0.9",
    "Psu-Accept": "application/json",
  });
  assertEquals(psuHeaders(new Request("https://x", { headers: { "user-agent": "a" } })), undefined);
});

Deno.test("frequenza delle letture dall'app", () => {
  const now = Date.parse("2026-11-16T12:00:00Z");
  assertEquals(refreshWait(null, true, now), null);
  assertEquals(refreshWait("2026-11-16T11:00:00Z", true, now), null);
  assertEquals(refreshWait("2026-11-16T11:50:00Z", true, now), 20 * 60_000);
  assertEquals(refreshWait("2026-11-16T11:50:00Z", false, now), null);
  assertEquals(refreshWait("2026-11-16T11:59:00Z", false, now), 60_000);
});
