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
  assert.deepEqual(await as("authenticated", LORIS, "select yrols.yrols_claim() as ok"), [{ ok: true }]);
  assert.deepEqual(await as("authenticated", OTHER, "select yrols.yrols_claim() as ok"), [{ ok: false }], "il secondo utente non entra");
  await as("authenticated", LORIS, "insert into yrols.reminders (text) values ('prova')");
  assert.equal((await as("authenticated", LORIS, "select * from yrols.reminders")).length, 1);
  assert.equal((await as("authenticated", OTHER, "select * from yrols.reminders")).length, 0);
  await assert.rejects(as("anon", null, "select * from yrols.reminders"));
  await assert.rejects(as("authenticated", OTHER, "insert into yrols.bills (provider, amount, due_date) values ('x', 1, current_date)"));
});

test("sync bancaria: solo service_role, upsert, saldo preferito e bollette pagate", async () => {
  const { as } = await setup();
  await as("authenticated", LORIS, "select yrols.yrols_claim()");
  await as("authenticated", LORIS, "insert into yrols.bills (provider, kind, amount, due_date) values ('Enel Energia', 'luce', 82.10, current_date)");
  await assert.rejects(as("authenticated", LORIS, "select yrols.yrols_bank_sync($1)", [payload]));
  await assert.rejects(as("anon", null, "select yrols.yrols_bank_sync($1)", [payload]));
  const [{ r }] = await as("service_role", null, "select yrols.yrols_bank_sync($1) r", [payload]);
  assert.deepEqual(r, { ok: true, connections: 1, accounts: 1, balances: 2, transactions: 1, billsMatched: 1 });
  await as("service_role", null, "select yrols.yrols_bank_sync($1)", [payload]);
  const acc = await as("authenticated", LORIS, "select * from yrols.yrols_accounts");
  assert.equal(acc.length, 1);
  assert.equal(acc[0].balance, 990);
  assert.equal((await as("authenticated", LORIS, "select * from yrols.yrols_transactions")).length, 1);
  assert.equal((await as("authenticated", OTHER, "select * from yrols.yrols_transactions")).length, 0);
  const [{ paid_at }] = await as("authenticated", LORIS, "select paid_at::text from yrols.bills");
  assert.equal(paid_at, today);
  await assert.rejects(as("service_role", null, "select yrols.yrols_bank_sync($1)", [{ transactions: [{ id: "x", accountId: "a1", amount: "1", bookingDate: today }] }]), /amount/);
});

test("panoramica e ricorrenze", async () => {
  const { as } = await setup();
  await as("authenticated", LORIS, "select yrols.yrols_claim()");
  await as("service_role", null, "select yrols.yrols_bank_sync($1)", [payload]);
  await as("authenticated", LORIS, "insert into yrols.deadlines (title, category, due_date, recurrence) values ('Bollo auto', 'auto', '2026-01-31', 'monthly')");
  await as("authenticated", LORIS, "update yrols.deadlines set done_at = current_date");
  const ds = await as("authenticated", LORIS, "select due_date::text d, done_at from yrols.deadlines order by id");
  assert.deepEqual(ds.map((x) => x.d), ["2026-01-31", "2026-02-28"]);
  const [{ o }] = await as("authenticated", LORIS, "select yrols.yrols_overview() o");
  assert.equal(o.netWorth, 990);
  assert.equal(o.last30.expenses, 82.1);
  assert.ok(o.agenda.some((a) => a.type === "consent"));
  // Una banca collegata senza conti (abbandonata) non genera il promemoria di rinnovo
  await as("service_role", null, "select yrols.yrols_bank_sync($1)", [{ connections: [{ id: "s2", bankName: "Abbandonata", validUntil: today + "T00:00:00Z" }] }]);
  const [{ o2 }] = await as("authenticated", LORIS, "select yrols.yrols_overview() o2");
  assert.equal(o2.agenda.filter((a) => a.type === "consent").length, 1);
  assert.equal(o.history.at(-1).total, 990);
  const [{ e }] = await as("authenticated", OTHER, "select yrols.yrols_overview() e");
  assert.equal(e.netWorth, 0, "un estraneo vede tutto vuoto");
});

test("proposte da email", async () => {
  const { as } = await setup();
  await as("authenticated", LORIS, "select yrols.yrols_claim()");
  await as("service_role", null, "insert into yrols.email_suggestions (message_id, subject, kind, provider, bill_kind, amount, due_date) values ('<m1>', 'Bolletta', 'bill', 'Hera', 'gas', 96.40, '2026-11-16')");
  const [{ r }] = await as("authenticated", LORIS, "select yrols.yrols_accept_suggestion(1, '{\"amount\":\"96,50\"}') r");
  const bills = await as("authenticated", LORIS, "select provider, amount::float8 a from yrols.bills");
  assert.deepEqual(bills, [{ provider: "Hera", a: 96.5 }]);
  assert.ok(r.id);
  await assert.rejects(as("authenticated", LORIS, "select yrols.yrols_accept_suggestion(1)"), /già gestita/);
});

test("Gmail collegata: token invisibile al cruscotto, stato senza segreti", async () => {
  const { as } = await setup();
  await as("authenticated", LORIS, "select yrols.yrols_claim()");
  await as("service_role", null, "insert into yrols.email_accounts (email, refresh_token, scope) values ('io@gmail.com', 'segreto', 'gmail.readonly')");
  await assert.rejects(as("authenticated", LORIS, "select refresh_token from yrols.email_accounts"), /permission denied/);
  await assert.rejects(as("anon", null, "select * from yrols.email_accounts"));
  await assert.rejects(as("authenticated", LORIS, "insert into yrols.email_auth_pending (state) values ('gm-x')"), /permission denied/);
  const [{ s }] = await as("authenticated", LORIS, "select yrols.yrols_email_status() s");
  assert.equal(s.account.email, "io@gmail.com");
  assert.equal(s.account.status, "active");
  assert.ok(!JSON.stringify(s).includes("segreto"), "il token non esce mai");
  const [{ o }] = await as("authenticated", OTHER, "select yrols.yrols_email_status() o");
  assert.equal(o, null, "un estraneo non vede la casella");
  await assert.rejects(as("anon", null, "select yrols.yrols_email_status()"));
});

test("fatture: niente doppioni tra PDF caricato e proposta email", async () => {
  const { as } = await setup();
  await as("authenticated", LORIS, "select yrols.yrols_claim()");
  // La mail arriva prima, senza PDF: resta una proposta.
  await as("service_role", null, "insert into yrols.email_suggestions (message_id, subject, kind, provider, bill_kind, amount, due_date) values ('<f1>', 'Conto Fastweb', 'bill', 'Fastweb', 'internet', 42.19, '2026-11-25')");
  const inv = { provider: "Fastweb", kind: "internet", amount: "42,19", dueDate: "2026-11-25", invoiceNumber: "M000000001", issueDate: "2026-11-01",
    periodFrom: "2026-10-01", periodTo: "2026-10-31", filePath: "manuale/x.pdf", source: "pdf", items: [{ description: "Canone", amount: 42.19, vat: 22 }] };
  const [{ r }] = await as("authenticated", LORIS, "select yrols.yrols_save_invoice($1) r", [inv]);
  assert.equal(r.merged, false);
  const [{ status, created_id }] = await as("authenticated", LORIS, "select status, created_id from yrols.email_suggestions");
  assert.equal(status, "accepted", "la proposta email della stessa fattura si chiude da sola");
  assert.equal(Number(created_id), Number(r.id));
  // Ricaricare lo stesso PDF completa la bolletta esistente.
  const [{ r: r2 }] = await as("authenticated", LORIS, "select yrols.yrols_save_invoice($1) r", [{ ...inv, notes: "ricaricata" }]);
  assert.deepEqual([r2.merged, Number(r2.id)], [true, Number(r.id)]);
  // Una bolletta inserita a mano senza numero viene completata dal PDF.
  await as("authenticated", LORIS, "insert into yrols.bills (provider, kind, amount, due_date) values ('Enel Energia', 'luce', 80, '2026-12-10')");
  const [{ r: r3 }] = await as("authenticated", LORIS, "select yrols.yrols_save_invoice($1) r", [{ provider: "enel energia", amount: 80, dueDate: "2026-12-10", invoiceNumber: "E1", filePath: "manuale/e.pdf" }]);
  assert.equal(r3.merged, true);
  const bills = await as("authenticated", LORIS, "select provider, invoice_number n, file_path f, source, jsonb_array_length(items) i from yrols.bills order by id");
  assert.deepEqual(bills, [
    { provider: "Fastweb", n: "M000000001", f: "manuale/x.pdf", source: "pdf", i: 1 },
    { provider: "Enel Energia", n: "E1", f: "manuale/e.pdf", source: "manuale", i: null },
  ]);
  await assert.rejects(as("authenticated", OTHER, "select yrols.yrols_save_invoice($1)", [inv]));
  await assert.rejects(as("anon", null, "select yrols.yrols_save_invoice($1)", [inv]));
  // Proposta email con PDF allegato: accettandola la bolletta eredita numero, voci e PDF.
  await as("service_role", null, "insert into yrols.email_suggestions (message_id, subject, kind, provider, bill_kind, amount, due_date, invoice_number, file_path) values ('<f2>', 'Fattura', 'bill', 'A2A', 'luce', 50, '2027-01-10', 'A9', 'email/a.pdf')");
  const [{ id }] = await as("authenticated", LORIS, "select id from yrols.email_suggestions where message_id = '<f2>'");
  await as("authenticated", LORIS, "select yrols.yrols_accept_suggestion($1)", [id]);
  const [a2a] = await as("authenticated", LORIS, "select invoice_number n, file_path f, source from yrols.bills where provider = 'A2A'");
  assert.deepEqual(a2a, { n: "A9", f: "email/a.pdf", source: "email" });
});

test("fornitori: solo membri, chiave unica, updated_at aggiornato", async () => {
  const { as } = await setup();
  await as("authenticated", LORIS, "select yrols.yrols_claim()");
  await as("authenticated", LORIS, "insert into yrols.suppliers (key, name, kind, monthly, direct_debit) values ('fastweb', 'Fastweb', 'internet', 37.9, true)");
  await assert.rejects(as("authenticated", LORIS, "insert into yrols.suppliers (key, name) values ('fastweb', 'Doppione')"));
  await assert.rejects(as("authenticated", LORIS, "insert into yrols.suppliers (key, name, kind) values ('x', 'X', 'pizza')"));
  await assert.rejects(as("authenticated", LORIS, "insert into yrols.suppliers (key, name) values ('Spazi Vietati', 'X')"));
  assert.equal((await as("authenticated", OTHER, "select * from yrols.suppliers")).length, 0);
  await assert.rejects(as("anon", null, "select * from yrols.suppliers"));
  const [before] = await as("authenticated", LORIS, "select updated_at from yrols.suppliers");
  await new Promise((r) => setTimeout(r, 20));
  await as("authenticated", LORIS, "update yrols.suppliers set status = 'nascosto'");
  const [after] = await as("authenticated", LORIS, "select status, updated_at from yrols.suppliers");
  assert.equal(after.status, "nascosto");
  assert.ok(after.updated_at > before.updated_at);
});

test("risparmio: offerte salvate dal controllo settimanale, stato conservato, solo membri", async () => {
  const { as } = await setup();
  await as("authenticated", LORIS, "select yrols.yrols_claim()");
  const offer = (o) => ({ category: "luce", provider: "Octopus Energy", name: "Flex", priceType: "variabile", monthlyCost: 41.5,
    currentMonthly: 49.2, currentProvider: "Sorgenia", priceDetails: "PUN + 0,0088 €/kWh", url: "https://example.org/o", source: "Selectra", ...o });
  const run1 = { sources: ["Selectra"], summary: "prova", offers: [offer({}), offer({ category: "internet", provider: "Iliad", name: "Box", monthlyCost: 24.99 })] };
  const [{ r }] = await as("service_role", null, "select yrols.yrols_save_offers($1) r", [run1]);
  assert.equal(r.offers, 2);
  // Loris la segna come vista e nasconde quella internet.
  await as("authenticated", LORIS, "update yrols.saving_offers set status = case category when 'luce' then 'vista' else 'nascosta' end");
  // Settimana dopo controllo solo la luce: Octopus cala di prezzo (torna "nuova"), internet non controllata resta com'era.
  const run2 = { sources: ["Selectra"], offers: [offer({ monthlyCost: 38 }), offer({ provider: "Edison", name: "Web Luce", monthlyCost: 45 })] };
  await as("authenticated", LORIS, "select yrols.yrols_save_offers($1)", [run2]);
  const rows = await as("authenticated", LORIS, "select category, provider, monthly_cost::float m, status, active from yrols.saving_offers order by id");
  assert.deepEqual(rows, [
    { category: "luce", provider: "Octopus Energy", m: 38, status: "nuova", active: true },
    { category: "internet", provider: "Iliad", m: 24.99, status: "nascosta", active: true },
    { category: "luce", provider: "Edison", m: 45, status: "nuova", active: true },
  ]);
  // Un controllo luce senza Edison la spegne.
  await as("service_role", null, "select yrols.yrols_save_offers($1)", [{ offers: [offer({ monthlyCost: 38 })] }]);
  assert.deepEqual((await as("authenticated", LORIS, "select active from yrols.saving_offers where provider = 'Edison'"))[0], { active: false });
  // Profilo: una riga sola, modificabile ma non eliminabile.
  await as("authenticated", LORIS, "update yrols.saving_profile set kwh_year = 2200");
  await assert.rejects(as("authenticated", LORIS, "delete from yrols.saving_profile"));
  await assert.rejects(as("authenticated", LORIS, "select yrols.yrols_save_offers($1)", [{ offers: [offer({ url: "http://x" })] }]));
  assert.equal((await as("authenticated", OTHER, "select * from yrols.saving_offers")).length, 0);
  await assert.rejects(as("anon", null, "select * from yrols.saving_offers"));
  await assert.rejects(as("anon", null, "select yrols.yrols_save_offers($1)", [run1]));
  // Prezzo promozionale: si salva anche il prezzo a regime e la durata della promo.
  await as("service_role", null, "select yrols.yrols_save_offers($1)", [{ offers: [offer({ category: "internet", provider: "Beactive", name: "Fiber", monthlyCost: 15.5, regularCost: 25.9, promoMonths: 6 })] }]);
  assert.deepEqual((await as("authenticated", LORIS, "select regular_cost::float r, promo_months p from yrols.saving_offers where provider = 'Beactive'"))[0], { r: 25.9, p: 6 });
  await assert.rejects(as("service_role", null, "select yrols.yrols_save_offers($1)", [{ offers: [offer({ promoMonths: 0 })] }]));
});
