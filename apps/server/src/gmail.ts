/**
 * Lettura di Gmail con l'API REST e un access token in sola lettura (gmail.readonly).
 * Produce lo stesso formato di readMailbox (IMAP), così il riconoscimento bollette è condiviso.
 */
import { simpleParser } from "mailparser";
import type { ParsedEmail } from "./emailParser.ts";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface GmailOptions { sinceDays: number; maxMessages: number; query?: string }

async function get<T>(f: typeof fetch, token: string, path: string): Promise<T> {
  const res = await f(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Gmail ${res.status} su ${path.split("?")[0]!.replace(/\/messages\/[^/]+$/, "/messages/…")}`);
  return res.json() as Promise<T>;
}

/** Id Gmail dei messaggi recenti (i più recenti per primi), escluse chat e social. */
export async function listMessageIds(token: string, opts: GmailOptions, f: typeof fetch = fetch): Promise<string[]> {
  const q = opts.query ?? `newer_than:${opts.sinceDays}d -in:chats -category:social`;
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const p = new URLSearchParams({ q, maxResults: String(Math.min(100, opts.maxMessages - ids.length)) });
    if (pageToken) p.set("pageToken", pageToken);
    const r = await get<{ messages?: { id: string }[]; nextPageToken?: string }>(f, token, `/messages?${p}`);
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
    const { raw } = await get<{ raw?: string }>(f, token, `/messages/${id}?format=raw`);
    if (!raw) continue;
    const parsed = await simpleParser(Buffer.from(raw, "base64url"));
    const text = parsed.text || (typeof parsed.html === "string" ? parsed.html.replace(/<[^>]+>/g, " ") : "");
    yield { messageId, email: { from: parsed.from?.text ?? "", subject: parsed.subject ?? "", text, date: parsed.date } };
  }
}
