/**
 * Pagamenti ricorrenti e proiezione della spesa mensile per conto.
 * Logica pura, senza database: la usa il cruscotto web (online e in locale) e la provano i test.
 *
 * Un pagamento è "ricorrente" quando lo stesso beneficiario compare sullo stesso conto quasi ogni mese,
 * con lo stesso numero di addebiti al mese (1 o 2) e un importo stabile, oppure quando è un addebito
 * diretto SDD (bollette a importo variabile). Giroconti tra i propri conti e salvadanai non contano.
 */

export interface RecTx {
  id: string; accountId: string; amount: number; bookingDate: string;
  description: string | null; counterparty: string | null; status?: string;
}
export interface RecAccount { id: string; name: string | null; bankName?: string | null }

export interface Recurring {
  key: string;
  accountId: string;
  label: string;
  /** Importo tipico di un addebito (positivo). */
  typical: number;
  /** Addebiti attesi in un mese. */
  perMonth: number;
  /** Spesa attesa in un mese intero (positiva). */
  monthly: number;
  /** Giorno del mese in cui di solito arriva l'addebito. */
  day: number;
  variable: boolean;
  directDebit: boolean;
  /** Mesi in cui è stato visto. */
  months: number;
  lastDate: string;
  txIds: string[];
}

export interface PlannedItem { id: string; label: string; amount: number; dueDate: string; source: "bill" | "deadline" }

export interface ProjectionItem {
  label: string; expected: number; paid: number; remaining: number;
  /** Data prevista del prossimo addebito nel mese, se manca ancora. */
  nextDate: string | null;
  recurring?: Recurring; planned?: PlannedItem;
}
export interface AccountProjection { accountId: string; expected: number; paid: number; remaining: number; items: ProjectionItem[] }
export interface Projection {
  month: string; expected: number; paid: number; remaining: number;
  accounts: AccountProjection[];
  /** Bollette e scadenze del cruscotto non riconducibili a un pagamento ricorrente già visto in banca. */
  planned: ProjectionItem[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const ym = (d: string) => d.slice(0, 7);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const addMonths = (month: string, n: number) => {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};
const daysInMonth = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
const dayDiff = (a: string, b: string) => Math.abs(Date.parse(a.slice(0, 10)) - Date.parse(b.slice(0, 10))) / 864e5;

// Parole che separano il nome del beneficiario dai dettagli tecnici (Fineco e altre banche italiane).
const CUT = /\s+(addebito sdd|addebito diretto|carta n\.|data operazione|data i\b|esercizio)/i;
const LEGAL = new Set(["spa", "srl", "snc", "sas", "gmbh", "ltd", "sa", "s", "p", "a", "r", "l", "ag", "bv", "inc", "di", "e"]);
const SDD = /\b(sdd|addebito diretto|rid|domiciliazione)\b/i;

function words(s: string | null, max: number) {
  if (!s) return "";
  return s.split(CUT)[0].toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z]+/g, " ").split(" ").filter((w) => w.length > 1 && !LEGAL.has(w)).slice(0, max).join(" ");
}

/** Chiave del beneficiario: stessa chiave = stesso pagamento. */
export function merchantKey(t: Pick<RecTx, "description" | "counterparty">) {
  return t.counterparty ? `${words(t.counterparty, 3)}|${words(t.description, 2)}` : words(t.description, 4);
}

const tidy = (raw: string) => {
  const s = raw.length > 48 ? raw.slice(0, 46).trimEnd() + "…" : raw;
  return s === s.toUpperCase() ? s.toLowerCase().replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase()) : s;
};
function prettyLabel(t: RecTx) {
  const main = tidy((t.counterparty || t.description || "Pagamento").split(CUT)[0].trim());
  // Con beneficiario e causale diversi (es. due rate dello stesso condominio) la causale aiuta a distinguerli.
  const d = words(t.description, 2);
  if (t.counterparty && d && !words(t.counterparty, 8).includes(d)) {
    const cause = (t.description ?? "").split(/[,.:;]/)[0].trim().split(/\s+/).slice(0, 3).join(" ");
    return `${main} · ${tidy(cause)}`;
  }
  return main;
}

const nameTokens = (s: string | null) => words(s, 8).split(" ").filter(Boolean).sort().join(" ");

/** Movimenti che sono spostamenti tra i propri conti (giroconti, salvadanai, ricariche). */
function internalIds(txs: RecTx[], accounts: RecAccount[]) {
  const own = new Set(accounts.map((a) => nameTokens(a.name)).filter(Boolean));
  const incoming = txs.filter((t) => t.amount > 0);
  const out = txs.filter((t) => t.amount < 0);
  const matched = (t: RecTx) => incoming.some((i) => i.accountId !== t.accountId && Math.abs(i.amount + t.amount) < 0.005 && dayDiff(i.bookingDate, t.bookingDate) <= 3);
  const ids = new Set<string>();
  // Un beneficiario è un giroconto se la maggior parte dei suoi addebiti ha l'accredito gemello su un altro conto proprio.
  const groups = new Map<string, RecTx[]>();
  for (const t of out) {
    const k = t.accountId + "\u0000" + merchantKey(t);
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  for (const g of groups.values()) {
    const m = g.filter(matched).length;
    const ownName = g.some((t) => own.has(nameTokens(t.counterparty)) || /^to eur\b/i.test(t.description ?? ""));
    if (ownName || m * 2 >= g.length) for (const t of g) ids.add(t.id);
  }
  return ids;
}

/** Mesi interi coperti dai dati di un conto (escluso il mese in corso e un primo mese parziale). */
function fullMonths(first: string, today: string) {
  let m = Number(first.slice(8, 10)) <= 3 ? ym(first) : addMonths(ym(first), 1);
  const out: string[] = [];
  while (m < ym(today)) { out.push(m); m = addMonths(m, 1); }
  return out.slice(-6);
}

export function findRecurring(txs: RecTx[], accounts: RecAccount[], today: string): Recurring[] {
  const internal = internalIds(txs, accounts);
  const firstByAccount = new Map<string, string>();
  for (const t of txs) {
    const f = firstByAccount.get(t.accountId);
    if (!f || t.bookingDate < f) firstByAccount.set(t.accountId, t.bookingDate);
  }
  const groups = new Map<string, RecTx[]>();
  for (const t of txs) {
    if (t.amount >= 0 || internal.has(t.id) || t.bookingDate.slice(0, 10) > today) continue;
    const key = merchantKey(t);
    if (!key.replace("|", "")) continue;
    const k = t.accountId + "\u0000" + key;
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }

  const result: Recurring[] = [];
  for (const [k, g] of groups) {
    const [accountId, key] = k.split("\u0000");
    g.sort((a, b) => a.bookingDate.localeCompare(b.bookingDate));
    const byMonth = new Map<string, RecTx[]>();
    for (const t of g) byMonth.set(ym(t.bookingDate), [...(byMonth.get(ym(t.bookingDate)) ?? []), t]);

    const full = fullMonths(firstByAccount.get(accountId)!, today);
    const window = full.length >= 2 ? full : [...byMonth.keys()];
    const present = window.filter((m) => byMonth.has(m));
    if (present.length < 2 || present.length < Math.ceil(window.length * 0.75)) continue;

    const counts = present.map((m) => byMonth.get(m)!.length);
    const maxC = Math.max(...counts), minC = Math.min(...counts);
    if (maxC > 2 || maxC - minC > 1) continue;
    const perMonth = Math.round(counts.reduce((s, c) => s + c, 0) / counts.length);

    const amounts = g.map((t) => -t.amount);
    const typical = median(amounts);
    const mean = amounts.reduce((s, a) => s + a, 0) / amounts.length;
    const cv = Math.sqrt(amounts.reduce((s, a) => s + (a - mean) ** 2, 0) / amounts.length) / mean;
    const directDebit = g.some((t) => SDD.test(t.description ?? ""));
    const variable = cv > 0.02;
    if (cv > 0.25 && !directDebit) continue;
    // Importo che cambia senza addebito diretto (es. stesso bar o negozio): serve vederlo in almeno 3 mesi.
    if (variable && !directDebit && byMonth.size < 3) continue;

    const days = g.map((t) => Number(t.bookingDate.slice(8, 10)));
    const day = Math.round(median(days));
    // Con un addebito al mese il giorno deve essere regolare (bollette SDD a parte: la data varia).
    if (perMonth === 1 && !directDebit && Math.max(...days.map((d) => Math.abs(d - day))) > 8) continue;

    // Spesa mensile: per gli importi variabili la media dei totali mensili, altrimenti l'importo tipico.
    const monthly = variable
      ? present.reduce((s, m) => s + byMonth.get(m)!.reduce((x, t) => x - t.amount, 0), 0) / present.length
      : typical * perMonth;

    result.push({
      key, accountId, label: prettyLabel(g[g.length - 1]), typical: round2(typical), perMonth, monthly: round2(monthly),
      day, variable, directDebit, months: byMonth.size, lastDate: g[g.length - 1].bookingDate.slice(0, 10), txIds: g.map((t) => t.id),
    });
  }
  return result.sort((a, b) => a.accountId.localeCompare(b.accountId) || a.day - b.day || b.monthly - a.monthly);
}

/**
 * Proiezione di un mese ("YYYY-MM"): per ogni conto quanto è atteso dai pagamenti ricorrenti,
 * quanto è già stato addebitato e quanto manca. Le bollette e scadenze del cruscotto si aggiungono
 * a parte, saltando quelle che corrispondono a un pagamento già riconosciuto in banca.
 */
export function projectMonth(recurring: Recurring[], txs: RecTx[], month: string, today: string, planned: PlannedItem[] = []): Projection {
  const byId = new Map(txs.map((t) => [t.id, t]));
  const accounts = new Map<string, AccountProjection>();
  const last = daysInMonth(month);

  for (const r of recurring) {
    const inMonth = r.txIds.map((id) => byId.get(id)!).filter((t) => t && ym(t.bookingDate) === month);
    const paid = round2(inMonth.reduce((s, t) => s - t.amount, 0));
    const missing = month < ym(today) ? 0 : Math.max(0, r.perMonth - inMonth.length);
    const remaining = round2(r.variable && inMonth.length === 0 ? r.monthly : missing * (r.variable ? r.monthly / r.perMonth : r.typical));
    let nextDate: string | null = null;
    if (remaining > 0) {
      const d = `${month}-${String(Math.min(r.day, last)).padStart(2, "0")}`;
      nextDate = d < today ? today : d;
    }
    const acc = accounts.get(r.accountId) ?? { accountId: r.accountId, expected: 0, paid: 0, remaining: 0, items: [] };
    acc.items.push({ label: r.label, expected: round2(paid + remaining), paid, remaining, nextDate, recurring: r });
    acc.paid += paid; acc.remaining += remaining;
    accounts.set(r.accountId, acc);
  }

  // Bollette/scadenze: si salta quella il cui fornitore è già un pagamento ricorrente (es. "Fastweb").
  const known = recurring.map((r) => r.key.split(/[| ]/)[0]).filter((w) => w.length > 2);
  const plannedItems: ProjectionItem[] = planned
    .filter((p) => ym(p.dueDate) === month && p.amount > 0)
    .filter((p) => !known.some((w) => words(p.label, 6).split(" ").includes(w)))
    .map((p) => ({ label: p.label, expected: round2(p.amount), paid: 0, remaining: round2(p.amount), nextDate: p.dueDate, planned: p }));

  const list = [...accounts.values()].map((a) => ({ ...a, paid: round2(a.paid), remaining: round2(a.remaining), expected: round2(a.paid + a.remaining) }))
    .sort((a, b) => b.expected - a.expected);
  const paid = round2(list.reduce((s, a) => s + a.paid, 0));
  const remaining = round2(list.reduce((s, a) => s + a.remaining, 0) + plannedItems.reduce((s, p) => s + p.remaining, 0));
  return { month, paid, remaining, expected: round2(paid + remaining), accounts: list, planned: plannedItems };
}
