// Client Enable Banking per Deno (Edge Functions Supabase).
// Stessa logica del connettore Node in connectors/enable-banking/src (jwt.ts, client.ts, normalize.ts):
// gli id dei movimenti devono coincidere, altrimenti il rinnovo duplicherebbe i dati.

export interface EbAmount { currency: string; amount: string }
export interface EbAccount {
  uid: string;
  account_id?: { iban?: string };
  name?: string;
  details?: string;
  product?: string;
  currency?: string;
  identification_hash?: string;
}
export interface EbBalance { balance_amount: EbAmount; balance_type: string; reference_date?: string; last_change_date_time?: string }
export interface EbTransaction {
  entry_reference?: string | null;
  transaction_id?: string | null;
  transaction_amount: EbAmount;
  credit_debit_indicator: "CRDT" | "DBIT";
  status: string;
  booking_date?: string | null;
  value_date?: string | null;
  transaction_date?: string | null;
  creditor?: { name?: string } | null;
  debtor?: { name?: string } | null;
  remittance_information?: string[] | null;
  note?: string | null;
  bank_transaction_code?: { description?: string } | null;
  reference_number?: string | null;
}
export interface EbSession {
  session_id: string;
  accounts: EbAccount[];
  aspsp: { name: string; country: string };
  access: { valid_until: string };
}

// ── JWT RS256 ──────────────────────────────────────────────────────────────

const b64url = (bytes: Uint8Array | string) => {
  const b = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

function pemToDer(pem: string): { der: Uint8Array<ArrayBuffer>; pkcs1: boolean } {
  const text = pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
  const pkcs1 = /BEGIN RSA PRIVATE KEY/.test(text);
  const body = text.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(body);
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return { der, pkcs1 };
}

function derLen(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  while (n > 0) { out.unshift(n & 0xff); n >>= 8; }
  return [0x80 | out.length, ...out];
}

/** WebCrypto importa solo PKCS#8: una chiave "BEGIN RSA PRIVATE KEY" (PKCS#1) va incapsulata. */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  const algId = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octet = [0x04, ...derLen(pkcs1.length), ...pkcs1];
  const inner = [0x02, 0x01, 0x00, ...algId, ...octet];
  return new Uint8Array([0x30, ...derLen(inner.length), ...inner]);
}

let cachedKey: { pem: string; key: CryptoKey } | undefined;
async function importKey(pem: string): Promise<CryptoKey> {
  if (cachedKey?.pem === pem) return cachedKey.key;
  const { der, pkcs1 } = pemToDer(pem);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    (pkcs1 ? pkcs1ToPkcs8(der) : der) as Uint8Array<ArrayBuffer>,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  cachedKey = { pem, key };
  return key;
}

export async function createJwt(appId: string, pem: string, ttlSeconds = 3600): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const header = { typ: "JWT", alg: "RS256", kid: appId };
  const payload = { iss: "enablebanking.com", aud: "api.enablebanking.com", iat, exp: iat + ttlSeconds };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await importKey(pem), new TextEncoder().encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

// ── Client ─────────────────────────────────────────────────────────────────

export class EbError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export class EnableBanking {
  constructor(private appId: string, private pem: string, private baseUrl = "https://api.enablebanking.com") {}

  async request<T>(method: string, path: string, body?: unknown, query?: Record<string, string | undefined>): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${await createJwt(this.appId, this.pem)}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let parsed: unknown = undefined;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
    if (!res.ok) {
      const msg = parsed && typeof parsed === "object" && "message" in parsed ? String((parsed as { message: unknown }).message) : text.slice(0, 200);
      throw new EbError(`Enable Banking ${method} ${path.replace(/\/accounts\/[^/]+/, "/accounts/…")} → ${res.status}: ${msg}`, res.status);
    }
    return parsed as T;
  }

  async aspsps(country: string) {
    const r = await this.request<{ aspsps: { name: string; country: string; logo?: string; maximum_consent_validity?: number; psu_types?: string[] }[] }>(
      "GET", "/aspsps", undefined, { country, psu_type: "personal" });
    return r.aspsps ?? [];
  }

  startAuth(bankName: string, country: string, validUntil: string, state: string, redirectUrl: string) {
    return this.request<{ url: string }>("POST", "/auth", {
      access: { valid_until: validUntil },
      aspsp: { name: bankName, country },
      state,
      redirect_url: redirectUrl,
      psu_type: "personal",
    });
  }

  createSession(code: string) { return this.request<EbSession>("POST", "/sessions", { code }); }
  deleteSession(id: string) { return this.request("DELETE", `/sessions/${encodeURIComponent(id)}`); }
  balances(uid: string) { return this.request<{ balances: EbBalance[] }>("GET", `/accounts/${encodeURIComponent(uid)}/balances`); }

  async transactions(uid: string, dateFrom: string): Promise<EbTransaction[]> {
    const all: EbTransaction[] = [];
    let key: string | undefined;
    for (let page = 0; page < 50; page++) {
      const r = await this.request<{ transactions: EbTransaction[]; continuation_key?: string | null }>(
        "GET", `/accounts/${encodeURIComponent(uid)}/transactions`, undefined, { date_from: dateFrom, continuation_key: key });
      all.push(...(r.transactions ?? []));
      if (!r.continuation_key || r.continuation_key === key) break;
      key = r.continuation_key;
    }
    return all;
  }
}

// ── Normalizzazione (identica a connectors/enable-banking/src/normalize.ts) ─

export function parseAmount(value: string | number | undefined | null): number {
  if (value === undefined || value === null || value === "") return 0;
  const n = typeof value === "number" ? value : Number(String(value).replace(",", "."));
  if (!Number.isFinite(n)) throw new Error(`Importo non valido: ${value}`);
  return Math.round(n * 100) / 100;
}
const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : undefined);

export function accountName(raw: EbAccount): string | undefined {
  const iban = raw.account_id?.iban;
  return raw.name || raw.product || raw.details || (iban ? `Conto ${iban.slice(-4)}` : undefined);
}

export function normalizeBalance(raw: EbBalance, accountId: string) {
  return {
    accountId,
    amount: parseAmount(raw.balance_amount.amount),
    currency: raw.balance_amount.currency,
    type: raw.balance_type,
    date: day(raw.reference_date) ?? day(raw.last_change_date_time) ?? new Date().toISOString().slice(0, 10),
  };
}

async function sha256Hex(s: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function normalizeTransaction(raw: EbTransaction, accountId: string) {
  const abs = Math.abs(parseAmount(raw.transaction_amount.amount));
  const amount = raw.credit_debit_indicator === "DBIT" ? -abs : abs;
  const bookingDate = day(raw.booking_date) ?? day(raw.transaction_date) ?? day(raw.value_date) ?? "";
  const counterparty = (raw.credit_debit_indicator === "DBIT" ? raw.creditor?.name : raw.debtor?.name) ?? undefined;
  const description =
    [...(raw.remittance_information ?? []), raw.note ?? ""].map((s) => s.trim()).filter(Boolean).join(" ") ||
    raw.bank_transaction_code?.description || counterparty || "";
  const id = raw.entry_reference || raw.transaction_id ||
    `h_${(await sha256Hex([accountId, bookingDate, day(raw.value_date) ?? "", amount.toFixed(2), raw.transaction_amount.currency, description, raw.reference_number ?? ""].join("|"))).slice(0, 32)}`;
  return {
    id, accountId, amount, currency: raw.transaction_amount.currency, bookingDate,
    valueDate: day(raw.value_date), description, counterparty,
    status: raw.status === "PDNG" ? "PDNG" : "BOOK",
  };
}
