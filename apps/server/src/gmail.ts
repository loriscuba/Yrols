/**
 * Lettura di Gmail con l'API REST e un access token in sola lettura (gmail.readonly).
 * Produce lo stesso formato di readMailbox (IMAP), così il riconoscimento bollette è condiviso.
 */
import { simpleParser } from "mailparser";
import { htmlToText, pdfAttachments, type ParsedEmail } from "./emailParser.ts";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface GmailOptions { sinceDays: number; maxMessages: number; query?: string; retryDelays?: number[]; onSkip?: (e: GmailError) => void }

const RETRY_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "backendError", "internalError"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GmailError extends Error {
  constructor(readonly status: number, readonly reason: string | undefined, path: string) {
    // Solo stato, motivo e percorso senza id: i log di Actions sono pubblici.
    super(`Gmail ${status}${reason ? ` (${reason})` : ""} su ${path.split("?")[0]!.replace(/\/messages\/[^/]+$/, "/messages/…")}`);
  }
}

/** GET con ritentativi (backoff esponenziale) sui limiti di frequenza e sugli errori temporanei di Google. */
async function get<T>(f: typeof fetch, token: string, path: string, retryDelays = [1000, 2000, 4000, 8000, 16000]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await f(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) return res.json() as Promise<T>;
    const body = await res.json().catch(() => null) as { error?: { errors?: { reason?: string }[]; status?: string } } | null;
    const reason = body?.error?.errors?.[0]?.reason ?? body?.error?.status;
    const retriable = res.status === 429 || res.status >= 500 || (res.status === 403 && !!reason && RETRY_REASONS.has(reason));
    if (!retriable || attempt >= retryDelays.length) throw new GmailError(res.status, reason, path);
    const after = Number(res.headers.get("Retry-After"));
    await sleep(after > 0 ? Math.min(after * 1000, 60_000) : retryDelays[attempt]!);
  }
}

/** Id Gmail dei messaggi recenti (i più recenti per primi), escluse chat e social. */
export async function listMessageIds(token: string, opts: GmailOptions, f: typeof fetch = fetch): Promise<string[]> {
  const q = opts.query ?? `newer_than:${opts.sinceDays}d -in:chats -category:social`;
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const p = new URLSearchParams({ q, maxResults: String(Math.min(100, opts.maxMessages - ids.length)) });
    if (pageToken) p.set("pageToken", pageToken);
    const r = await get<{ messages?: { id: string }[]; nextPageToken?: string }>(f, token, `/messages?${p}`, opts.retryDelays);
    ids.push(...(r.messages ?? []).map((m) => m.id));
    pageToken = r.nextPageToken;
  } while (pageToken && ids.length < opts.maxMessages);
  return ids.slice(0, opts.maxMessages);
}

export const gmailMessageId = (id: string) => `gmail:${id}`;

export async function* readGmail(token: string, opts: GmailOptions, seen: Set<string>, f: typeof fetch = fetch):
  AsyncGenerator<{ messageId: string; email: ParsedEmail }> {
  for (const id of await listMessageIds(token, opts, f)) {
    const messageId = gmailMessageId(id);
    if (seen.has(messageId)) continue;
    let raw: string | undefined;
    try {
      ({ raw } = await get<{ raw?: string }>(f, token, `/messages/${id}?format=raw`, opts.retryDelays));
    } catch (e) {
      // Un singolo messaggio illeggibile non deve fermare la lettura: verrà ritentato alla prossima ora.
      // Un token scaduto o revocato (401) invece sì.
      if (!(e instanceof GmailError) || e.status === 401) throw e;
      opts.onSkip?.(e);
      continue;
    }
    if (!raw) continue;
    const parsed = await simpleParser(Buffer.from(raw, "base64url"));
    const text = parsed.text || (typeof parsed.html === "string" ? htmlToText(parsed.html) : "");
    yield { messageId, email: { from: parsed.from?.text ?? "", subject: parsed.subject ?? "", text, date: parsed.date, pdfs: pdfAttachments(parsed) } };
  }
}
