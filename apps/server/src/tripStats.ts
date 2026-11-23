/**
 * Statistica Vacanza: quanto si è speso in un viaggio, a partire dai movimenti dei conti.
 * Logica pura, senza database: la usa la pagina Statistiche e la provano i test.
 *
 * Un movimento appartiene a un viaggio quando:
 *  - la data dell'operazione cade tra l'inizio e la fine del viaggio (per le carte Fineco vale la
 *    "Data operazione" scritta nella descrizione, non quella di contabilizzazione, che arriva giorni dopo);
 *  - oppure la descrizione contiene una parola chiave del viaggio (es. "Turkish Airlines", "Holafly") e la data
 *    è nei 120 giorni prima o nei 7 dopo: così entrano voli e prenotazioni pagati in anticipo;
 *  - oppure è stato aggiunto a mano. Quelli tolti a mano non contano mai.
 * Giroconti tra i propri conti, salvadanai e ricariche non sono spesa. I rimborsi (refund, storno) la riducono.
 * Se due viaggi si contendono un movimento per parola chiave, vince quello che inizia più vicino a quella data.
 */

export interface TripTx {
  id: string; accountId: string; amount: number; bookingDate: string;
  description: string | null; counterparty: string | null; accountName?: string | null; bankName?: string | null;
}
export interface TripAccount { id: string; name: string | null }

export interface TripConfig {
  country?: string | null;
  from: string;
  to?: string | null;
  keywords?: string[];
  include?: string[];
  exclude?: string[];
}
export interface Trip { id: number | string; title: string; config: TripConfig }

export type Category = "alloggio" | "trasporti" | "ristoranti" | "spesa" | "contanti" | "attrazioni" | "acquisti";
export const CATEGORY_LABELS: Record<Category, string> = {
  alloggio: "Alloggio", trasporti: "Viaggio e trasporti", ristoranti: "Ristoranti e caffè", spesa: "Supermercati e konbini",
  contanti: "Prelievi contanti", attrazioni: "Musei e attrazioni", acquisti: "Shopping e altro",
};

export interface TripLine extends TripTx {
  /** Data dell'operazione (per le carte può precedere la contabilizzazione). */
  date: string;
  /** Spesa positiva (un rimborso è negativo). */
  spent: number;
  category: Category;
  merchant: string;
  /** Perché è nel viaggio. */
  reason: "date" | "keyword" | "manual";
  excluded: boolean;
}

export interface TripResult {
  trip: Trip;
  from: string;
  to: string;
  days: number;
  total: number;
  perDay: number;
  /** Spese pagate prima della partenza (voli, prenotazioni). */
  before: number;
  count: number;
  lines: TripLine[];
  byCategory: { category: Category; label: string; total: number }[];
  byDay: { date: string; total: number }[];
  topMerchants: { merchant: string; total: number; count: number }[];
}

const DAY = 864e5;
const toTime = (iso: string) => new Date(iso.slice(0, 10) + "T00:00:00Z").getTime();
const addDays = (iso: string, n: number) => new Date(toTime(iso) + n * DAY).toISOString().slice(0, 10);
const dayDiff = (a: string, b: string) => Math.round((toTime(a) - toTime(b)) / DAY);
const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9& ]+/g, " ").replace(/\s+/g, " ").trim();
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Data dell'operazione: le carte Fineco la scrivono nella descrizione ("Data operazione 20/11/26"). */
export function operationDate(t: Pick<TripTx, "bookingDate" | "description">) {
  const m = /data operazione:?\s*(\d{2})\/(\d{2})\/(\d{2,4})/i.exec(t.description ?? "");
  if (m) {
    const y = m[3].length === 2 ? "20" + m[3] : m[3];
    const iso = `${y}-${m[2]}-${m[1]}`;
    if (!Number.isNaN(toTime(iso)) && Math.abs(dayDiff(t.bookingDate, iso)) <= 15) return iso;
  }
  return t.bookingDate.slice(0, 10);
}

/** Paese della carta, quando la banca lo scrive ("ASTIRD KUYUMCULUK Istanbul TR Carta N. ..."). */
export function cardCountry(t: Pick<TripTx, "description">) {
  const m = /\b([A-Z]{2})\s+Carta N\./.exec(t.description ?? "");
  return m ? m[1] : null;
}

/** Nome leggibile dell'esercente. */
export function merchantName(t: Pick<TripTx, "description" | "counterparty">) {
  const d = t.description ?? "";
  const card = /^(.*?)\s+[A-Z]{2}\s+Carta N\./.exec(d);
  const raw = t.counterparty?.trim() || (card ? card[1] : d).replace(/^refund from\s+/i, "").trim() || "Movimento";
  const s = raw.replace(/\s+/g, " ").slice(0, 60);
  return s === s.toUpperCase() ? s.toLowerCase().replace(/(^|[\s(/-])\p{L}/gu, (c) => c.toUpperCase()) : s;
}

const RULES: [Category, RegExp][] = [
  ["contanti", /\bcash at\b|\bprelievo\b|\batm\b/],
  ["alloggio", /hotel|hoteru|\botel\b|hostel|ryokan|booking com|airbnb|\binn\b|guest ?house|apart/],
  ["trasporti", /airline|airways|\bair\b|aeroport|airport|airporter|\bkix\b|\bmxp\b|suica|pasmo|\bjr\b|railway|train|shinkansen|taxi|takushi|uber|bolt|metro|transit|istanbulkart|\bbus\b|ferry|parking|parcheggio|autopark|holafly|esim|wi fi|wifi|pier|ticino srl|car rental|rent a car/],
  ["attrazioni", /museum|museo|castle|castello|temple|tempio|shrine|jinja|religious|topkapi|teamlab|palace|saray|ticket|biglietto|omairi|baiten|kinkaku|ryoan|tower/],
  ["spesa", /seven eleven|7 eleven|lawson|familymart|family mart|ministop|supermarket|supermercato|market|migros|\bbim\b|a101|\bsok\b|carrefour|don ?quijote|donki|delica|\bgida\b/],
  ["ristoranti", /restaurant|ristorante|sushi|ramen|coffee|caffe|cafe|kahve|starbucks|sbx|tully|mcdonald|burger|pizza|bento|izakaya|okonomiyaki|\bbar\b|pastane|lokanta|kebap|doner|saizeriya|menson|kitchen|bistro|gelat|bakery|panificio|pankarato|plusta|baklava|\bcay\b/],
];

export function categorize(t: Pick<TripTx, "description" | "counterparty">): Category {
  const s = " " + norm(`${t.counterparty ?? ""} ${t.description ?? ""}`) + " ";
  for (const [c, re] of RULES) if (re.test(s)) return c;
  return "acquisti";
}

const nameTokens = (s: string | null | undefined) => norm(s).split(" ").filter(Boolean).sort().join(" ");

/**
 * Movimenti che sono spostamenti tra i propri conti: salvadanai Revolut ("To EUR Emergenze", "From Conto Deposito"),
 * bonifici verso un conto proprio o cointestato, ricariche della carta Revolut da Fineco, e in generale
 * coppie addebito/accredito dello stesso importo su due conti propri a pochi giorni di distanza.
 */
export function internalIds(txs: TripTx[], accounts: TripAccount[]) {
  const own = new Set(accounts.map((a) => nameTokens(a.name)).filter(Boolean));
  const ids = new Set<string>();
  const isOwn = (s: string | null | undefined) => {
    const k = nameTokens(s);
    if (!k) return false;
    if (own.has(k)) return true;
    // "Loris C", "CUBAIU LORIS": stesso titolare scritto in breve.
    return [...own].some((o) => { const a = o.split(" "), b = k.split(" "); return b.length >= 2 && b.every((w) => a.some((x) => x === w || (w.length === 1 && x.startsWith(w)))); });
  };
  for (const t of txs) {
    const d = t.description ?? "";
    const target = /\b(?:to|from)\s+(.+)$/i.exec(d)?.[1] ?? null;
    if (
      /^(?:.*\s)?(?:to|from)\s+(?:eur\b|conto deposito|pocket|salvadanaio|vault)/i.test(d)
      || /apple pay top-up|top-up by|ricarica revolut|^revolut\*\*/i.test(d)
      || /^giroconto\b/i.test(d)
      || isOwn(t.counterparty) || (target !== null && isOwn(target))
    ) ids.add(t.id);
  }
  // Coppie gemelle tra due conti propri (stesso importo opposto, entro 3 giorni).
  const pos = txs.filter((t) => t.amount > 0);
  for (const t of txs) {
    if (t.amount >= 0 || ids.has(t.id)) continue;
    const twin = pos.find((p) => p.accountId !== t.accountId && Math.abs(p.amount + t.amount) < 0.005 && Math.abs(dayDiff(p.bookingDate, t.bookingDate)) <= 3
      && (isOwn(p.counterparty) || /\bfrom\b/i.test(p.description ?? "") || isOwn(t.counterparty)));
    if (twin) { ids.add(t.id); ids.add(twin.id); }
  }
  return ids;
}

/** Addebiti di casa che capitano durante il viaggio ma non c'entrano: SDD, bonifici, rate, PAC, estratti conto carta. */
const HOME_DEBIT = /addebito sdd|sepa direct debit|data inserimento|piano bonifico|rata pac|estratto conto|canone mensile|\bf24\b|bollettino/i;
export const isHomeDebit = (t: Pick<TripTx, "description">) => HOME_DEBIT.test(t.description ?? "");

const isRefund = (t: TripTx) => /\b(refund|rimborso|storno|reso)\b/i.test(t.description ?? "");

/** Ultimo giorno del viaggio: se non c'è la data di fine è in corso, fino a oggi. */
const tripEnd = (c: TripConfig, today: string) => (c.to && c.to >= c.from ? c.to : today);

export function computeTrips(trips: Trip[], txs: TripTx[], accounts: TripAccount[], today: string): TripResult[] {
  const internal = internalIds(txs, accounts);
  const kw = trips.map((tr) => (tr.config.keywords ?? []).map(norm).filter((k) => k.length >= 3));
  // Ogni movimento con parola chiave va al viaggio che inizia più vicino.
  const keywordOwner = new Map<string, number>();
  for (const t of txs) {
    const date = operationDate(t);
    const text = " " + norm(`${t.counterparty ?? ""} ${t.description ?? ""}`) + " ";
    let best = -1, bestDist = Infinity;
    trips.forEach((tr, i) => {
      if (!kw[i].some((k) => text.includes(k))) return;
      const from = tr.config.from, to = tripEnd(tr.config, today);
      if (date < addDays(from, -120) || date > addDays(to, 7)) return;
      const dist = Math.abs(dayDiff(date, from));
      if (dist < bestDist) { best = i; bestDist = dist; }
    });
    if (best >= 0) keywordOwner.set(t.id, best);
  }

  return trips.map((trip, i) => {
    const c = trip.config;
    const from = c.from, to = tripEnd(c, today);
    const include = new Set(c.include ?? []), exclude = new Set(c.exclude ?? []);
    const lines: TripLine[] = [];
    for (const t of txs) {
      const date = operationDate(t);
      const manual = include.has(t.id);
      const inRange = date >= from && date <= to;
      const byKeyword = keywordOwner.get(t.id) === i;
      if (!manual && !inRange && !byKeyword) continue;
      if (!manual && internal.has(t.id)) continue;
      // Durante il viaggio non contano le spese di casa né le carte usate in Italia (se il viaggio è all'estero).
      if (!manual && !byKeyword && (isHomeDebit(t) || (c.country && c.country !== "IT" && cardCountry(t) === "IT"))) continue;
      if (t.amount === 0) continue;
      if (t.amount > 0 && !manual && !isRefund(t)) continue;
      lines.push({
        ...t, date, spent: round2(-t.amount), category: categorize(t), merchant: merchantName(t),
        reason: manual ? "manual" : inRange ? "date" : "keyword", excluded: exclude.has(t.id),
      });
    }
    lines.sort((a, b) => (a.date === b.date ? b.spent - a.spent : a.date < b.date ? -1 : 1));
    const counted = lines.filter((l) => !l.excluded);
    const total = round2(counted.reduce((s, l) => s + l.spent, 0));
    const days = Math.max(1, dayDiff(to, from) + 1);
    const before = round2(counted.filter((l) => l.date < from).reduce((s, l) => s + l.spent, 0));

    const cat = new Map<Category, number>();
    for (const l of counted) cat.set(l.category, (cat.get(l.category) ?? 0) + l.spent);
    const byCategory = [...cat].map(([category, v]) => ({ category, label: CATEGORY_LABELS[category], total: round2(v) }))
      .filter((x) => x.total > 0).sort((a, b) => b.total - a.total);

    const byDay: { date: string; total: number }[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) byDay.push({ date: d, total: round2(counted.filter((l) => l.date === d).reduce((s, l) => s + l.spent, 0)) });

    const merch = new Map<string, { merchant: string; total: number; count: number }>();
    for (const l of counted) {
      const k = norm(l.merchant).replace(/\d+/g, "").trim() || l.merchant;
      const m = merch.get(k) ?? { merchant: l.merchant.replace(/\s*\d+$/, ""), total: 0, count: 0 };
      m.total += l.spent; m.count += 1; merch.set(k, m);
    }
    const topMerchants = [...merch.values()].map((m) => ({ ...m, total: round2(m.total) })).filter((m) => m.total > 0)
      .sort((a, b) => b.total - a.total).slice(0, 8);

    return {
      trip, from, to, days, total, perDay: round2((total - before) / days), before,
      count: counted.filter((l) => l.spent > 0).length, lines, byCategory, byDay, topMerchants,
    };
  });
}

/** Primo giorno da cui servono i movimenti per calcolare i viaggi. */
export const earliestNeeded = (trips: Trip[]) => trips.reduce((m, t) => { const d = addDays(t.config.from, -120); return d < m ? d : m; }, "9999-12-31");

export const COUNTRIES: [string, string][] = [
  ["JP", "Giappone"], ["TR", "Turchia"], ["ES", "Spagna"], ["FR", "Francia"], ["GB", "Regno Unito"], ["DE", "Germania"], ["PT", "Portogallo"],
  ["GR", "Grecia"], ["NL", "Paesi Bassi"], ["AT", "Austria"], ["CH", "Svizzera"], ["HR", "Croazia"], ["US", "Stati Uniti"], ["TH", "Thailandia"],
  ["KR", "Corea del Sud"], ["CN", "Cina"], ["MA", "Marocco"], ["EG", "Egitto"], ["IT", "Italia"],
];
/** Bandiera emoji dal codice paese a due lettere. */
export const flag = (cc: string | null | undefined) =>
  cc && /^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : "🌍";
