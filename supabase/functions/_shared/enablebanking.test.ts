// deno test supabase/functions/_shared/enablebanking.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createJwt, normalizeTransaction } from "./enablebanking.ts";

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
