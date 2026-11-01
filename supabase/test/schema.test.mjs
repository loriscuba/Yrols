// Prova lo schema Supabase su un Postgres in memoria (PGlite), con un finto schema "auth".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const dir = new URL("../migrations/", import.meta.url);
const STUB = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  grant usage on schema auth, public to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  insert into auth.users values ('11111111-1111-1111-1111-111111111111'), ('22222222-2222-2222-2222-222222222222');
`;
const LORIS = "11111111-1111-1111-1111-111111111111", OTHER = "22222222-2222-2222-2222-222222222222";

async function setup() {
  const db = new PGlite();
  await db.exec(STUB);
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) await db.exec(readFileSync(new URL(f, dir), "utf8"));
  const as = async (role, uid, sql, params) => {
    await db.exec(`reset role; select set_config('test.uid', '${uid ?? ""}', false); set role ${role};`);
    try { return (await db.query(sql, params)).rows; } finally { await db.exec("reset role"); }
  };
  return { db, as };
}

const today = new Date().toISOString().slice(0, 10);
const payload = {
  source: "enablebanking", syncedAt: new Date().toISOString(),
  connections: [{ id: "s1", bankName: "Fineco", country: "IT", validUntil: today + "T00:00:00Z", status: "active" }],
  accounts: [{ id: "a1", name: "Conto", bankName: "Fineco", iban: "IT00", currency: "EUR", connectionId: "s1" }],
  balances: [{ accountId: "a1", amount: 1000, type: "CLBD", date: today }, { accountId: "a1", amount: 990, type: "ITAV", date: today }],
  transactions: [{ id: "t1", accountId: "a1", amount: -82.1, currency: "EUR", bookingDate: today, description: "SDD ENEL ENERGIA" }],
};

test("accesso: solo il proprietario, anon non vede nulla", async () => {
  const { as } = await setup();
  assert.deepEqual(await as("authenticated", LORIS, "select public.yrols_claim() as ok"), [{ ok: true }]);
  assert.deepEqual(await as("authenticated", OTHER, "select public.yrols_claim() as ok"), [{ ok: false }], "il secondo utente non entra");
  await as("authenticated", LORIS, "insert into public.reminders (text) values ('prova')");
  assert.equal((await as("authenticated", LORIS, "select * from public.reminders")).length, 1);
  assert.equal((await as("authenticated", OTHER, "select * from public.reminders")).length, 0);
  await assert.rejects(as("anon", null, "select * from public.reminders"));
  await assert.rejects(as("authenticated", OTHER, "insert into public.bills (provider, amount, due_date) values ('x', 1, current_date)"));
});

test("sync bancaria: solo service_role, upsert, saldo preferito e bollette pagate", async () => {
  const { as } = await setup();
  await as("authenticated", LORIS, "select public.yrols_claim()");
  await as("authenticated", LORIS, "insert into public.bills (provider, kind, amount, due_date) values ('Enel Energia', 'luce', 82.10, current_date)");
  await assert.rejects(as("authenticated", LORIS, "select public.yrols_bank_sync($1)", [payload]));
  await assert.rejects(as("anon", null, "select public.yrols_bank_sync($1)", [payload]));
  const [{ r }] = await as("service_role", null, "select public.yrols_bank_sync($1) r", [payload]);
  assert.deepEqual(r, { ok: true, connections: 1, accounts: 1, balances: 2, transactions: 1, billsMatched: 1 });
  await as("service_role", null, "select public.yrols_bank_sync($1)", [payload]);
  const acc = await as("authenticated", LORIS, "select * from public.yrols_accounts");
  assert.equal(acc.length, 1);
  assert.equal(acc[0].balance, 990);
  assert.equal((await as("authenticated", LORIS, "select * from public.yrols_transactions")).length, 1);
  assert.equal((await as("authenticated", OTHER, "select * from public.yrols_transactions")).length, 0);
  const [{ paid_at }] = await as("authenticated", LORIS, "select paid_at::text from public.bills");
  assert.equal(paid_at, today);
  await assert.rejects(as("service_role", null, "select public.yrols_bank_sync($1)", [{ transactions: [{ id: "x", accountId: "a1", amount: "1", bookingDate: today }] }]), /amount/);
});

test("panoramica e ricorrenze", async () => {
  const { as } = await setup();
  await as("authenticated", LORIS, "select public.yrols_claim()");
  await as("service_role", null, "select public.yrols_bank_sync($1)", [payload]);
  await as("authenticated", LORIS, "insert into public.deadlines (title, category, due_date, recurrence) values ('Bollo auto', 'auto', '2026-01-31', 'monthly')");
  await as("authenticated", LORIS, "update public.deadlines set done_at = current_date");
  const ds = await as("authenticated", LORIS, "select due_date::text d, done_at from public.deadlines order by id");
  assert.deepEqual(ds.map((x) => x.d), ["2026-01-31", "2026-02-28"]);
  const [{ o }] = await as("authenticated", LORIS, "select public.yrols_overview() o");
  assert.equal(o.netWorth, 990);
  assert.equal(o.last30.expenses, 82.1);
  assert.ok(o.agenda.some((a) => a.type === "consent"));
  assert.equal(o.history.at(-1).total, 990);
  const [{ e }] = await as("authenticated", OTHER, "select public.yrols_overview() e");
  assert.equal(e.netWorth, 0, "un estraneo vede tutto vuoto");
});

test("proposte da email", async () => {
  const { as } = await setup();
  await as("authenticated", LORIS, "select public.yrols_claim()");
  await as("service_role", null, "insert into public.email_suggestions (message_id, subject, kind, provider, bill_kind, amount, due_date) values ('<m1>', 'Bolletta', 'bill', 'Hera', 'gas', 96.40, '2026-11-16')");
  const [{ r }] = await as("authenticated", LORIS, "select public.yrols_accept_suggestion(1, '{\"amount\":\"96,50\"}') r");
  const bills = await as("authenticated", LORIS, "select provider, amount::float8 a from public.bills");
  assert.deepEqual(bills, [{ provider: "Hera", a: 96.5 }]);
  assert.ok(r.id);
  await assert.rejects(as("authenticated", LORIS, "select public.yrols_accept_suggestion(1)"), /già gestita/);
});
