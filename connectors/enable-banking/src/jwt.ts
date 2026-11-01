import { createPrivateKey, sign, type KeyObject } from "node:crypto";

/**
 * Enable Banking autentica ogni chiamata con un JWT RS256 firmato con la
 * chiave privata dell'applicazione. Header: kid = application id.
 * Claims: iss "enablebanking.com", aud "api.enablebanking.com", iat, exp
 * (durata massima 24 ore).
 */
export const MAX_JWT_TTL_SECONDS = 24 * 60 * 60;

export function loadPrivateKey(pem: string | KeyObject): KeyObject {
  if (typeof pem !== "string") return pem;
  // Permette chiavi passate in variabile d'ambiente con "\n" letterali.
  const normalized = pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
  return createPrivateKey(normalized);
}

const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

export function createJwt(
  applicationId: string,
  privateKey: KeyObject,
  ttlSeconds = 3600,
  nowMs = Date.now(),
): { token: string; expiresAt: number } {
  if (!applicationId) throw new Error("applicationId mancante");
  const ttl = Math.min(Math.max(ttlSeconds, 60), MAX_JWT_TTL_SECONDS);
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + ttl;
  const header = { typ: "JWT", alg: "RS256", kid: applicationId };
  const payload = { iss: "enablebanking.com", aud: "api.enablebanking.com", iat, exp };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), privateKey);
  return { token: `${signingInput}.${b64url(signature)}`, expiresAt: exp * 1000 };
}
