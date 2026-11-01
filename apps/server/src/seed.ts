/** Popola il database con dati di esempio, per provare il cruscotto senza banca né email collegate. */
import { fileURLToPath } from "node:url";
import { openDb } from "./db.ts";
import { applySync } from "./banks.ts";
import { insertRow, matchBillsWithTransactions } from "./household.ts";
import { storeSuggestion } from "./email.ts";

const db = openDb(process.env.YROLS_DB ?? fileURLToPath(new URL("../../../data/yrols.db", import.meta.url)));
const has = (db.prepare("SELECT (SELECT COUNT(*) FROM bills) + (SELECT COUNT(*) FROM bank_accounts) AS n").get() as { n: number }).n;
if (has && !process.argv.includes("--force")) {
  console.log("Il database contiene già dati: non tocco nulla (usa --force per aggiungere comunque gli esempi).");
  process.exit(0);
}

const d = (offset: number) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

const accounts = [
  { id: "demo-cc", name: "Conto corrente famiglia", bankName: "Banca Demo", iban: "IT60X0542811101000000123456", currency: "EUR", connectionId: "demo-session" },
  { id: "demo-risp", name: "Conto deposito", bankName: "Banca Demo", iban: "IT02A0301503200000003517230", currency: "EUR", connectionId: "demo-session" },
];
const balances: { accountId: string; amount: number; type: string; date: string }[] = [];
const transactions: any[] = [];
let cc = 3200, risp = 15000;
for (let i = 180; i >= 0; i--) {
  const date = d(-i), dom = Number(date.slice(8, 10));
  const push = (amount: number, description: string, counterparty: string) => {
    transactions.push({ id: `demo-${date}-${transactions.length}`, accountId: "demo-cc", amount, currency: "EUR", bookingDate: date, description, counterparty, status: "BOOK" });
    cc += amount;
  };
  if (dom === 27) push(2450, "STIPENDIO", "Datore di lavoro Srl");
  if (dom === 5) push(-620, "RATA MUTUO", "Banca Demo");
  if (dom === 1) { push(-300, "GIROCONTO RISPARMIO", "Conto deposito"); risp += 300; }
  if (rnd() < 0.55) push(-Math.round((15 + rnd() * 90) * 100) / 100, "PAGAMENTO POS SUPERMERCATO", "Supermercato");
  if (rnd() < 0.12) push(-Math.round((20 + rnd() * 60) * 100) / 100, "RIFORNIMENTO CARBURANTE", "Distributore");
  if (i % 7 === 0) {
    balances.push({ accountId: "demo-cc", amount: Math.round(cc * 100) / 100, type: "CLBD", date });
    balances.push({ accountId: "demo-risp", amount: risp, type: "CLBD", date });
  }
}
// Addebito della bolletta luce già pagata (verrà riconosciuto automaticamente)
transactions.push({ id: "demo-enel", accountId: "demo-cc", amount: -78.4, currency: "EUR", bookingDate: d(-12), description: "ADDEBITO SDD ENEL ENERGIA", counterparty: "Enel Energia", status: "BOOK" });
balances.push({ accountId: "demo-cc", amount: Math.round((cc - 78.4) * 100) / 100, type: "CLBD", date: d(0) });

applySync(db, {
  source: "demo", syncedAt: new Date().toISOString(),
  connections: [{ id: "demo-session", bankName: "Banca Demo", country: "IT", validUntil: d(10) + "T00:00:00Z", status: "active" }],
  accounts, balances, transactions,
});

for (const b of [
  { provider: "Enel Energia", kind: "luce", amount: 78.4, dueDate: d(-10), periodFrom: d(-70), periodTo: d(-10) },
  { provider: "Eni Plenitude", kind: "gas", amount: 112.9, dueDate: d(6) },
  { provider: "Acea", kind: "acqua", amount: 54.2, dueDate: d(18) },
  { provider: "Fastweb", kind: "internet", amount: 29.95, dueDate: d(-2) },
  { provider: "Condominio Via Roma", kind: "condominio", amount: 240, dueDate: d(25) },
  { provider: "Enel Energia", kind: "luce", amount: 91.15, dueDate: d(-70), paidAt: d(-72) },
  { provider: "Eni Plenitude", kind: "gas", amount: 168.3, dueDate: d(-55), paidAt: d(-56) },
]) insertRow(db, "bills", b);

for (const s of [
  { title: "Bollo auto", category: "auto", dueDate: d(21), amount: 245, recurrence: "yearly" },
  { title: "Rinnovo RC auto", category: "assicurazione", dueDate: d(40), amount: 480, recurrence: "yearly" },
  { title: "Acconto IMU", category: "tasse", dueDate: d(3), amount: 380, recurrence: "semiannual" },
  { title: "Revisione caldaia", category: "casa", dueDate: d(60), recurrence: "yearly" },
  { title: "Scadenza carta d'identità Loris", category: "documenti", dueDate: d(150) },
]) insertRow(db, "deadlines", s);

for (const r of [
  { text: "Leggere il contatore del gas", priority: "normale", remindAt: d(2) + "T09:00:00" },
  { text: "Chiedere preventivo infissi", priority: "bassa" },
  { text: "Portare l'auto dal meccanico", priority: "alta", remindAt: d(1) + "T08:30:00" },
]) insertRow(db, "reminders", r);

storeSuggestion(db, "<demo-1@example>", { from: "Hera Comm <bollette@gruppohera.it>", subject: "È disponibile la tua bolletta gas",
  text: "Gentile cliente, l'importo da pagare è € 96,40 con scadenza " + d(15).split("-").reverse().join("/") + ".", date: new Date() });
storeSuggestion(db, "<demo-2@example>", { from: "ACI <noreply@aci.it>", subject: "Promemoria: bollo auto in scadenza",
  text: "Il bollo del veicolo scade il " + d(45).split("-").reverse().join("/") + ". Importo € 198,00", date: new Date() });

console.log(`Dati di esempio caricati. Bollette riconosciute come pagate dalla banca: ${matchBillsWithTransactions(db)}.`);
