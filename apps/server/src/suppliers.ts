/**
 * Anagrafica fornitori: riconosce chi fornisce le utenze di casa (luce, gas, internet, telefono, acqua,
 * condominio, …) incrociando movimenti delle banche, pagamenti ricorrenti, bollette/fatture e proposte email.
 * Logica pura, senza database: la usa il cruscotto web (online e in locale) e la provano i test.
 *
 * Le schede salvate dall'utente (nome, tipo, codice cliente, note, fornitore nascosto) vincono sui dati riconosciuti.
 */
import { PROVIDERS } from "./emailParser.ts";
import type { RecTx, Recurring } from "./recurring.ts";

export interface SupplierBill { id: number | string; provider: string; kind?: string | null; amount: number; dueDate: string; paidAt?: string | null; invoiceNumber?: string | null }
export interface SupplierEmail { id: number | string; provider: string | null; billKind?: string | null; amount: number | null; dueDate: string | null; kind?: string }

/** Scheda salvata dall'utente (tabella "suppliers"). */
export interface SavedSupplier {
  id: number; key: string; name: string; kind: string; status: "attivo" | "nascosto";
  customerCode?: string | null; contractCode?: string | null; website?: string | null; phone?: string | null; notes?: string | null;
  /** Ultima stima della spesa mensile salvata dal cruscotto (la leggono altre pagine, es. Risparmio). */
  monthly?: number | null; directDebit?: boolean | null;
}

export interface SupplierPayment { id: string; date: string; amount: number; accountId: string; directDebit: boolean }

export interface Supplier {
  key: string;
  name: string;
  kind: string;
  /** true se è un fornitore di utenze (catalogo, condominio, bollette); false per altri addebiti ricorrenti. */
  utility: boolean;
  sources: { bank: number; bills: number; email: number };
  accountIds: string[];
  directDebit: boolean;
  /** Identificativo creditore SDD letto dalla causale (es. IT34001000…), utile per riconoscere il mandato. */
  creditorId: string | null;
  /** Spesa media al mese (positiva): dal pagamento ricorrente se c'è, altrimenti dai pagamenti visti. */
  monthly: number;
  lastPayment: SupplierPayment | null;
  payments: SupplierPayment[];
  bills: SupplierBill[];
  recurring: Recurring[];
  saved: SavedSupplier | null;
  hidden: boolean;
}

// Fornitori in più rispetto a quelli letti dalle email (stesso formato: espressione, nome, tipo).
const EXTRA: [RegExp, string, string][] = [
  [/\bho\.? ?mobile\b/i, "ho. Mobile", "telefono"],
  [/very ?mobile/i, "Very Mobile", "telefono"],
  [/kena ?mobile/i, "Kena Mobile", "telefono"],
  [/postemobile|poste ?energia/i, "Poste", "telefono"],
  [/\bengie\b/i, "Engie", "gas"],
  [/e\.?on energia|\beon\b/i, "E.ON Energia", "luce"],
  [/\bestra\b/i, "Estra", "gas"],
  [/agsm|aim energy/i, "AGSM AIM", "luce"],
  [/dolomiti energia/i, "Dolomiti Energia", "luce"],
  [/\bpulsee\b/i, "Pulsee", "luce"],
  [/\bnen\b/i, "NeN", "luce"],
  [/tiscali/i, "Tiscali", "internet"],
  [/\beolo\b/i, "Eolo", "internet"],
  [/open ?fiber/i, "Open Fiber", "internet"],
  [/linkem|tiscali ?mobile/i, "Linkem", "internet"],
  [/acquedotto|servizio idrico|gestore idrico/i, "Servizio idrico", "acqua"],
];
// Nei movimenti "Eni 01397" è un distributore di carburante: per Eni serve il nome del servizio luce/gas.
const ENI: [RegExp, string, string] = [/plenitude|eni gas e luce|eni\s+s\.?p\.?a\.?\s+addebito/i, "Eni Plenitude", "gas"];
export const CATALOG: [RegExp, string, string][] = [...PROVIDERS.filter(([, n]) => n !== "Condominio" && n !== "Eni Plenitude"), ENI, ...EXTRA];

const CONDO = /\b(condominio|amministrazione condominiale|supercondominio)\b/i;
const SDD = /\b(sdd|addebito diretto|rid|domiciliazione)\b/i;
// Come in recurring.ts: dove finisce il nome del beneficiario e iniziano i dettagli tecnici della banca.
const CUT = /\s+(addebito sdd|addebito diretto|carta n\.|data operazione|data i\b|esercizio)/i;
const CREDITOR = /\bda\s+([A-Z]{2}\d{2}[A-Z0-9]{3,30})\b/;

const round2 = (n: number) => Math.round(n * 100) / 100;
const ym = (d: string) => d.slice(0, 7);

export const slug = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const titleCase = (s: string) => s.toLowerCase().replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase());

function condoName(text: string) {
  // "CONDOMINIO VIA DON MINZONI 1A - 1B" e "Condominio Via Don Minzoni" sono lo stesso condominio:
  // il nome finisce al primo numero civico o segno di punteggiatura.
  const m = text.match(/condominio\s+(.*)/i);
  const out: string[] = [];
  for (const w of (m?.[1] ?? "").split(/\s+/)) {
    if (!/^[\p{L}']+$/u.test(w) || out.length === 4) break;
    out.push(w);
  }
  return out.length ? `Condominio ${titleCase(out.join(" "))}` : "Condominio";
}

/** Fornitore riconosciuto in un testo (causale, beneficiario, nome in bolletta): nome e tipo di utenza. */
export function identify(text: string | null | undefined): { name: string; kind: string } | null {
  if (!text) return null;
  const t = text.split(CUT)[0];
  if (CONDO.test(t)) return { name: condoName(t), kind: "condominio" };
  const hit = CATALOG.find(([re]) => re.test(t));
  return hit ? { name: hit[1], kind: hit[2] } : null;
}

/** Fornitore di un movimento: prima dal beneficiario, poi dalla causale. */
const identifyTx = (t: Pick<RecTx, "description" | "counterparty">) => identify(t.counterparty) ?? identify(t.description);

export interface SupplierInput {
  txs: RecTx[];
  recurring: Recurring[];
  bills?: SupplierBill[];
  emails?: SupplierEmail[];
  saved?: SavedSupplier[];
  today: string;
}

export function buildSuppliers({ txs, recurring, bills = [], emails = [], saved = [], today }: SupplierInput): Supplier[] {
  const map = new Map<string, Supplier>();
  const get = (name: string, kind: string, utility: boolean) => {
    const key = slug(name);
    let s = map.get(key);
    if (!s) {
      s = { key, name, kind, utility, sources: { bank: 0, bills: 0, email: 0 }, accountIds: [], directDebit: false, creditorId: null,
        monthly: 0, lastPayment: null, payments: [], bills: [], recurring: [], saved: null, hidden: false };
      map.set(key, s);
    }
    if (utility && !s.utility) { s.utility = true; s.kind = kind; }
    return s;
  };
  const addPayment = (s: Supplier, t: RecTx) => {
    if (s.payments.some((p) => p.id === t.id)) return;
    const dd = SDD.test(t.description ?? "");
    s.payments.push({ id: t.id, date: t.bookingDate.slice(0, 10), amount: round2(-t.amount), accountId: t.accountId, directDebit: dd });
    if (dd) s.directDebit = true;
    s.creditorId ??= (t.description ?? "").match(CREDITOR)?.[1] ?? null;
    if (!s.accountIds.includes(t.accountId)) s.accountIds.push(t.accountId);
  };

  // 1. Movimenti in uscita verso un fornitore conosciuto (anche se non ancora ricorrenti).
  const out = txs.filter((t) => t.amount < 0 && t.bookingDate.slice(0, 10) <= today);
  for (const t of out) {
    const id = identifyTx(t);
    if (id) addPayment(get(id.name, id.kind, true), t);
  }

  // 2. Pagamenti ricorrenti: quelli di un fornitore conosciuto si uniscono alla sua scheda, gli altri restano "altri addebiti".
  const byId = new Map(txs.map((t) => [t.id, t]));
  for (const r of recurring) {
    const sample = r.txIds.map((id) => byId.get(id)).find(Boolean);
    const id = (sample && identifyTx(sample)) ?? identify(r.label);
    const s = id ? get(id.name, id.kind, true) : get(r.label.split(" · ")[0], "altro", false);
    s.recurring.push(r);
    for (const tid of r.txIds) { const t = byId.get(tid); if (t) addPayment(s, t); }
  }

  // 3. Bollette e fatture salvate, poi proposte email ancora da confermare.
  for (const b of bills) {
    const id = identify(b.provider);
    const s = get(id?.name ?? b.provider.trim(), id?.kind ?? b.kind ?? "altro", true);
    s.bills.push(b);
    if (b.kind && b.kind !== "altro" && s.kind === "altro") s.kind = b.kind;
  }
  for (const e of emails) {
    if (!e.provider || (e.kind && e.kind !== "bill")) continue;
    const id = identify(e.provider);
    const s = get(id?.name ?? e.provider.trim(), id?.kind ?? e.billKind ?? "altro", true);
    s.sources.email++;
  }

  // 4. Schede salvate: correggono nome e tipo, aggiungono fornitori inseriti a mano, nascondono i falsi positivi.
  for (const sv of saved) {
    const s = map.get(sv.key) ?? get(sv.name, sv.kind, true);
    s.saved = sv;
    s.name = sv.name || s.name;
    s.kind = sv.kind || s.kind;
    s.hidden = sv.status === "nascosto";
    if (sv.status === "attivo") s.utility = true;
  }

  // Spesa media al mese.
  const first = out.reduce((m, t) => (t.bookingDate < m ? t.bookingDate : m), today).slice(0, 10);
  const span = Math.max(1, (Date.parse(today) - Date.parse(first)) / 864e5 / 30.44);
  for (const s of map.values()) {
    s.payments.sort((a, b) => b.date.localeCompare(a.date));
    s.lastPayment = s.payments[0] ?? null;
    s.sources.bank = s.payments.length;
    s.sources.bills = s.bills.length;
    s.bills.sort((a, b) => b.dueDate.localeCompare(a.dueDate));
    if (s.recurring.length) s.monthly = round2(s.recurring.reduce((x, r) => x + r.monthly, 0));
    else if (s.payments.length) {
      // Pagamenti sparsi (es. bimestrali): totale diviso per i mesi da quando ci sono dati, almeno dal primo pagamento.
      const months = new Set(s.payments.map((p) => ym(p.date))).size;
      s.monthly = round2(s.payments.reduce((x, p) => x + p.amount, 0) / Math.max(months, span));
    } else if (s.bills.length) {
      const yearAgo = String(Number(today.slice(0, 4)) - 1) + today.slice(4);
      const recent = s.bills.filter((b) => b.dueDate > yearAgo);
      s.monthly = round2(recent.reduce((x, b) => x + b.amount, 0) / 12);
    }
  }

  const order = ["luce", "gas", "acqua", "internet", "telefono", "rifiuti", "condominio", "affitto", "mutuo", "altro"];
  return [...map.values()].sort((a, b) =>
    Number(b.utility) - Number(a.utility) || order.indexOf(a.kind) - order.indexOf(b.kind) || b.monthly - a.monthly || a.name.localeCompare(b.name));
}
