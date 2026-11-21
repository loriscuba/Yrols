// Web Push senza librerie: firma VAPID (RFC 8292) e cifratura del contenuto aes128gcm (RFC 8291) con la sola WebCrypto,
// così lo stesso codice gira nella Edge Function (Deno) e nei test (Node).

const enc = new TextEncoder();
// WebCrypto vuole BufferSource: con TypeScript recente Uint8Array generico non basta, a runtime è identico.
const B = (b: Uint8Array) => b as unknown as ArrayBuffer;

export function b64u(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64u(s: string): Uint8Array {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", B(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: B(salt), info: B(info) }, key, len * 8));
}

export type VapidKeys = { publicKey: string; privateJwk: JsonWebKey };

/** Nuova coppia di chiavi VAPID: la pubblica (65 byte, base64url) va al browser, la privata resta nel database. */
export async function generateVapidKeys(): Promise<VapidKeys> {
  const k = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const privateJwk = await crypto.subtle.exportKey("jwk", k.privateKey);
  const publicKey = b64u(await crypto.subtle.exportKey("raw", k.publicKey));
  return { publicKey, privateJwk };
}

/** Intestazione Authorization VAPID per il servizio push dell'endpoint (valida 12 ore). */
export async function vapidAuth(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): Promise<string> {
  const header = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey("jwk", { ...keys.privateJwk, key_ops: ["sign"] }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, B(enc.encode(`${header}.${claims}`)));
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${keys.publicKey}`;
}

/** Cifra il contenuto per un'iscrizione (chiavi p256dh e auth del browser), formato aes128gcm a un solo record. */
export async function encryptPayload(payload: Uint8Array, p256dh: string, auth: string, salt = crypto.getRandomValues(new Uint8Array(16))): Promise<Uint8Array> {
  const uaPublic = fromB64u(p256dh);
  const as = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", B(uaPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(fromB64u(auth), shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", B(cek), "AES-GCM", false, ["encrypt"]);
  // Delimitatore 0x02: ultimo (e unico) record.
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: B(nonce) }, key, B(concat(payload, new Uint8Array([2])))));
  const rs = 4096;
  const head = new Uint8Array(21);
  head.set(salt, 0);
  new DataView(head.buffer).setUint32(16, rs);
  head[20] = asPublic.length;
  return concat(head, asPublic, cipher);
}

export type Subscription = { endpoint: string; p256dh: string; auth: string };
export type PushMessage = { title: string; body?: string; url?: string; tag?: string };

/** Spedisce una notifica. Restituisce lo stato HTTP del servizio push (201 = consegnata; 404/410 = iscrizione scaduta). */
export async function sendPush(sub: Subscription, msg: PushMessage, keys: VapidKeys, subject: string, fetchFn: typeof fetch = fetch): Promise<number> {
  const body = await encryptPayload(enc.encode(JSON.stringify(msg)), sub.p256dh, sub.auth);
  const res = await fetchFn(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuth(sub.endpoint, keys, subject),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "normal",
    },
    body: B(body),
  });
  await res.body?.cancel();
  return res.status;
}

export type Notice = { kind: string; title: string; body: string | null; url: string | null };

const KIND_LABEL: Record<string, [string, string]> = {
  movimento: ["nuovo movimento", "nuovi movimenti"],
  portafoglio: ["portafoglio aggiornato", "portafogli aggiornati"],
  offerta: ["nuova offerta", "nuove offerte"],
};

/** Riassume più novità in una sola notifica (una sincronizzazione può portarne parecchie). */
export function summarize(items: Notice[]): PushMessage | null {
  if (!items.length) return null;
  if (items.length === 1) {
    const n = items[0]!;
    return { title: n.title, body: n.body ?? "", url: n.url ?? "/", tag: `yrols-${n.kind}` };
  }
  const kinds = [...new Set(items.map((n) => n.kind))];
  const title = kinds.length === 1 ? `${items.length} ${KIND_LABEL[kinds[0]!]?.[1] ?? "novità"}` : `${items.length} novità in Yrols`;
  const lines = items.slice(0, 4).map((n) => (kinds.length === 1 && n.kind === "movimento" ? `${n.title} · ${(n.body ?? "").split(" · ")[0]}` : n.title));
  if (items.length > 4) lines.push(`e altre ${items.length - 4}`);
  const urls = [...new Set(items.map((n) => n.url ?? "/"))];
  return { title, body: lines.join("\n"), url: urls.length === 1 ? urls[0] : "/", tag: "yrols" };
}
