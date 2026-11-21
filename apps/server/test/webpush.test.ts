import { test } from "node:test";
import assert from "node:assert/strict";
import { b64u, concat, encryptPayload, fromB64u, generateVapidKeys, hkdf, sendPush, summarize, vapidAuth } from "../../../supabase/functions/_shared/webpush.ts";

const enc = new TextEncoder();
const B = (b: Uint8Array) => b as unknown as ArrayBuffer;

/** Lato browser: decifra come farebbe il servizio push del telefono (RFC 8291). */
async function decrypt(body: Uint8Array, ua: CryptoKeyPair, auth: Uint8Array) {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16);
  const idlen = body[20]!;
  const asPublic = body.slice(21, 21 + idlen);
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey));
  const asKey = await crypto.subtle.importKey("raw", B(asPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, ua.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", B(cek), "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: B(nonce) }, key, B(body.slice(21 + idlen))));
  assert.equal(plain[plain.length - 1], 2, "delimitatore dell'ultimo record");
  assert.equal(rs, 4096);
  return new TextDecoder().decode(plain.slice(0, -1));
}

async function browser() {
  const ua = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const p256dh = b64u(await crypto.subtle.exportKey("raw", ua.publicKey));
  return { ua, auth, sub: { endpoint: "https://web.push.apple.com/QGuQ-abc", p256dh, auth: b64u(auth) } };
}

test("cifratura aes128gcm: il browser legge il messaggio", async () => {
  const { ua, auth, sub } = await browser();
  const msg = JSON.stringify({ title: "Uscita 82,10 €", body: "Enel · Fineco" });
  const body = await encryptPayload(enc.encode(msg), sub.p256dh, sub.auth);
  assert.equal(await decrypt(body, ua, auth), msg);
});

test("VAPID: firma ES256 verificabile con la chiave pubblica, aud = origine del servizio push", async () => {
  const keys = await generateVapidKeys();
  assert.equal(fromB64u(keys.publicKey).length, 65);
  const h = await vapidAuth("https://fcm.googleapis.com/fcm/send/xyz", keys, "https://loriscuba.github.io/Yrols/", 1_700_000_000_000);
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h)!;
  assert.ok(m);
  assert.equal(m[4], keys.publicKey);
  const claims = JSON.parse(new TextDecoder().decode(fromB64u(m[2]!)));
  assert.deepEqual(claims, { aud: "https://fcm.googleapis.com", exp: 1_700_000_000 + 43200, sub: "https://loriscuba.github.io/Yrols/" });
  const pub = await crypto.subtle.importKey("raw", B(fromB64u(keys.publicKey)), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, B(fromB64u(m[3]!)), B(enc.encode(`${m[1]}.${m[2]}`)));
  assert.ok(ok);
});

test("invio: intestazioni giuste e stato del servizio push", async () => {
  const { ua, auth, sub } = await browser();
  const keys = await generateVapidKeys();
  let seen: RequestInit | undefined;
  const fake = (async (url: string, init: RequestInit) => { assert.equal(url, sub.endpoint); seen = init; return new Response(null, { status: 201 }); }) as unknown as typeof fetch;
  assert.equal(await sendPush(sub, { title: "Prova", url: "/banche" }, keys, "https://x/", fake), 201);
  const h = seen!.headers as Record<string, string>;
  assert.equal(h["Content-Encoding"], "aes128gcm");
  assert.equal(h.TTL, "86400");
  assert.match(h.Authorization!, /^vapid t=/);
  assert.deepEqual(JSON.parse(await decrypt(new Uint8Array(seen!.body as ArrayBuffer), ua, auth)), { title: "Prova", url: "/banche" });
});

test("riassunto: una novità com'è, più novità in una sola notifica", () => {
  const tx = (t: string, b: string) => ({ kind: "movimento", title: t, body: b, url: "/banche" });
  assert.equal(summarize([]), null);
  assert.deepEqual(summarize([tx("Uscita 5,00 €", "Bar · Fineco")]), { title: "Uscita 5,00 €", body: "Bar · Fineco", url: "/banche", tag: "yrols-movimento" });
  assert.deepEqual(summarize([tx("Uscita 5,00 €", "Bar · Fineco"), tx("Entrata 10,00 €", "Mario · Revolut")]),
    { title: "2 nuovi movimenti", body: "Uscita 5,00 € · Bar\nEntrata 10,00 € · Mario", url: "/banche", tag: "yrols" });
  const mixed = summarize([tx("Uscita 5,00 €", "Bar"), { kind: "offerta", title: "Nuova offerta luce: X", body: "…", url: "/risparmio" }])!;
  assert.equal(mixed.title, "2 novità in Yrols");
  assert.equal(mixed.url, "/");
  const many = summarize(Array.from({ length: 6 }, (_, i) => tx(`Uscita ${i},00 €`, "Bar")))!;
  assert.equal(many.body!.split("\n").length, 5);
  assert.match(many.body!, /e altre 2$/);
});
