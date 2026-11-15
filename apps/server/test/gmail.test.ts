import { test } from "node:test";
import assert from "node:assert/strict";
import { readGmail, listMessageIds } from "../src/gmail.ts";
import { parseEmail } from "../src/emailParser.ts";

const rfc822 = (subject: string, body: string) => Buffer.from(
  `From: Hera Comm <bollette@heracomm.it>\r\nTo: io@example.com\r\nSubject: ${subject}\r\nDate: Mon, 9 Nov 2026 10:00:00 +0100\r\n` +
  `Message-ID: <x@hera>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`).toString("base64url");

function fakeGmail(pages: string[][]) {
  const calls: string[] = [];
  const f = (async (input: string | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    calls.push(u.pathname + u.search);
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer tok");
    if (u.pathname.endsWith("/messages")) {
      const i = Number(u.searchParams.get("pageToken") ?? 0);
      return Response.json({ messages: pages[i]!.map((id) => ({ id })), nextPageToken: pages[i + 1] ? String(i + 1) : undefined });
    }
    const id = u.pathname.split("/").pop();
    return Response.json({ id, raw: rfc822(`Bolletta gas ${id}`, "Totale da pagare 96,40 euro, scadenza 16/11/2026.") });
  }) as typeof fetch;
  return { f, calls };
}

test("Gmail: elenco paginato, filtro su chat/social e limite", async () => {
  const { f, calls } = fakeGmail([["a", "b"], ["c", "d"]]);
  assert.deepEqual(await listMessageIds("tok", { sinceDays: 30, maxMessages: 3 }, f), ["a", "b", "c"]);
  const q = new URLSearchParams(calls[0]!.split("?")[1]);
  assert.equal(q.get("q"), "newer_than:30d -in:chats -category:social");
});

test("Gmail: salta i messaggi già visti e riconosce la bolletta", async () => {
  const { f, calls } = fakeGmail([["a", "b"]]);
  const out = [];
  for await (const m of readGmail("tok", { sinceDays: 30, maxMessages: 50 }, new Set(["gmail:a"]), f)) out.push(m);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.messageId, "gmail:b");
  assert.ok(!calls.some((c) => c.includes("/messages/a")), "il messaggio già visto non viene scaricato");
  assert.match(calls.at(-1)!, /format=raw/);
  const s = parseEmail(out[0]!.email);
  assert.equal(s?.kind, "bill");
  assert.equal(s?.amount, 96.4);
  assert.equal(s?.dueDate, "2026-11-16");
});

test("Gmail: errore leggibile senza dati personali", async () => {
  const f = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(listMessageIds("tok", { sinceDays: 1, maxMessages: 1 }, f), /Gmail 401 su \/messages$/);
});

test("Gmail: ritenta sul limite di frequenza e salta il messaggio che resta illeggibile", async () => {
  const hits: Record<string, number> = {};
  const err = (status: number, reason: string) => Response.json({ error: { errors: [{ reason }] } }, { status });
  const f = (async (input: string | URL) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/messages")) return Response.json({ messages: [{ id: "a" }, { id: "b" }, { id: "c" }] });
    const id = u.pathname.split("/").pop()!;
    hits[id] = (hits[id] ?? 0) + 1;
    if (id === "a" && hits[id] === 1) return err(403, "userRateLimitExceeded");
    if (id === "b") return err(403, "forbidden");
    return Response.json({ raw: rfc822(`Bolletta ${id}`, "Totale 10,00 euro, scadenza 16/11/2026.") });
  }) as typeof fetch;
  const skipped: string[] = [];
  const out = [];
  for await (const m of readGmail("tok", { sinceDays: 30, maxMessages: 50, retryDelays: [0, 0], onSkip: (e) => skipped.push(e.message) }, new Set(), f)) out.push(m.messageId);
  assert.deepEqual(out, ["gmail:a", "gmail:c"]);
  assert.equal(hits.a, 2, "ritentato dopo il limite di frequenza");
  assert.equal(hits.b, 1, "un 403 non temporaneo non si ritenta");
  assert.deepEqual(skipped, ["Gmail 403 (forbidden) su /messages/…"]);
});

test("Gmail: token scaduto (401) ferma la lettura", async () => {
  const f = (async (input: string | URL) => new URL(String(input)).pathname.endsWith("/messages")
    ? Response.json({ messages: [{ id: "a" }] }) : new Response("", { status: 401 })) as typeof fetch;
  await assert.rejects((async () => { for await (const _ of readGmail("tok", { sinceDays: 1, maxMessages: 5, retryDelays: [] }, new Set(), f)); })(), /Gmail 401/);
});
