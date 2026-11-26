/**
 * Spesa Famiglia: le uscite di un conto (di solito il cointestato) negli ultimi mesi, per categoria e per mese,
 * con i consigli su dove si può risparmiare. Logica pura, senza database: la usa la pagina Statistiche.
 *
 * Non contano i giroconti tra i propri conti. Le spese fatte durante una vacanza (Statistica Vacanza)
 * finiscono tutte in "Viaggi", così non gonfiano ristoranti e shopping di tutti i giorni.
 */
import { internalIds, isRefund, merchantName, norm, operationDate, placeKey, type TripAccount, type TripResult, type TripTx } from "./tripStats.ts";

export type FamilyCategory =
  | "spesa" | "panetteria" | "ristoranti" | "delivery" | "casa" | "bambini" | "salute" | "abbigliamento" | "online"
  | "abbonamenti" | "tempolibero" | "trasporti" | "regali" | "viaggi" | "persone" | "altro";

export const FAMILY_LABELS: Record<FamilyCategory, string> = {
  spesa: "Supermercati", panetteria: "Pane, forno e alimentari", ristoranti: "Ristoranti, bar e gelati", delivery: "Cibo a domicilio",
  casa: "Casa e pulizie", bambini: "Bambini", salute: "Farmacia e salute", abbigliamento: "Abbigliamento e scarpe", online: "Acquisti online",
  abbonamenti: "Abbonamenti e telefono", tempolibero: "Tempo libero e bagni", trasporti: "Auto, parcheggi e trasporti", regali: "Regali ed eventi",
  viaggi: "Viaggi", persone: "Pagamenti a persone", altro: "Altro",
};

const RULES: [FamilyCategory, RegExp][] = [
  ["delivery", /deliveroo|just ?eat|glovo|uber ?eats/],
  ["abbonamenti", /iliad|fastweb|vodafone|\btim\b|windtre|ho mobile|amazon prime|kindle|netflix|spotify|disney|apple com bill|icloud|dazn|youtube/],
  ["online", /amazon|amzn|aliexpress|temu|zalando|shein|ebay|erbologica|wanapix|\bwww\b/],
  ["bambini", /pannolin|prenatal|chicco|giocattol|toys|baby/],
  ["salute", /farmacia|parafarmacia|medic|ottica|dentist|\bdm fil|\bdm drogerie/],
  ["spesa", /supermercat|carrefour|\bcrf\b|ekom|eurospin|\bcoop\b|conad|lidl|esselunga|\bprix\b|superstore|di per di|\bd \b|tigota|basko|penny|\bmd\b|crai|despar/],
  ["panetteria", /forno|panific|panifici|pane\b|macelleri|ortofrutt|vostro orto|fior di aroma|alimentari|eataly|pasticceri/],
  ["ristoranti", /ristorant|trattoria|pizz|\bbar\b|caff|cafe|gelat|osteria|enoteca|wine bar|casa del vino|birra|pub\b|sushi|kebab|catering|tosta|pro loco|societa operaia|s m s|fratellanza|arci|mychef|autogrill/],
  ["tempolibero", /bagni|lido|piscina|palestra|eventim|ticketone|cinema|teatro|feltrinelli|libraccio|libr|museo|associazione sport|mentelocale/],
  ["casa", /brico|leroy|ikea|tedi|profumo del pulito|lavanderi|ferrament|casa\b|arco ufficio|cartoler|flora|fiori/],
  ["abbigliamento", /\bovs\b|pittarello|takko|zara|h&m|decathlon|calzedonia|intimissimi|scarpe|ago e filo/],
  ["trasporti", /\beni\b|\bq8\b|\bip\b|tamoil|esso|parchegg|autopark|skidata|amt\b|tpl\b|trenitalia|italo|autostrad|telepass|ads |looking4/],
  ["regali", /prezola|lista nozze|regalo/],
  ["viaggi", /booking|airbnb|airline|turkish|ryanair|easyjet|hotel|holafly/],
];

export function familyCategory(t: Pick<TripTx, "description" | "counterparty">): FamilyCategory {
  const s = " " + norm(`${t.counterparty ?? ""} ${t.description ?? ""}`) + " ";
  for (const [c, re] of RULES) if (re.test(s)) return c;
  // Bonifico o PayPal verso una persona.
  if (/(?:^| )to [a-z]|paypal|satispay/.test(norm(t.description))) return "persone";
  return "altro";
}

export interface FamilyPlace { c?: FamilyCategory; d?: string }
export interface Advice { title: string; text: string; saving?: number | null }
export interface FamilyConfig { accountId: string; months?: number; places?: Record<string, FamilyPlace>; advice?: Advice[]; exclude?: string[] }

export interface FamilyLine extends TripTx { date: string; spent: number; category: FamilyCategory; merchant: string; info: string | null; excluded: boolean; trip: string | null }
export interface FamilyResult {
  from: string; to: string; months: number; total: number; perMonth: number; count: number;
  byCategory: { category: FamilyCategory; label: string; total: number; perMonth: number; count: number }[];
  byMonth: ({ month: string; total: number } & Partial<Record<FamilyCategory, number>>)[];
  topMerchants: { merchant: string; total: number; count: number }[];
  lines: FamilyLine[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const ym = (d: string) => d.slice(0, 7);

export function computeFamily(cfg: FamilyConfig, txs: TripTx[], accounts: TripAccount[], trips: TripResult[], today: string): FamilyResult {
  const months = cfg.months ?? 12;
  const start = new Date(today + "T00:00:00Z"); start.setUTCMonth(start.getUTCMonth() - months);
  const own = txs.filter((t) => t.accountId === cfg.accountId);
  const first = own.reduce((m, t) => (operationDate(t) < m ? operationDate(t) : m), today);
  const from = [start.toISOString().slice(0, 10), first].sort()[1];
  const internal = internalIds(txs, accounts);
  const tripOf = new Map<string, string>();
  for (const r of trips) for (const l of r.lines) if (!l.excluded) tripOf.set(l.id, r.trip.title);
  const exclude = new Set(cfg.exclude ?? []);

  const lines: FamilyLine[] = [];
  for (const t of own) {
    const date = operationDate(t);
    if (date < from || date > today || t.amount === 0 || internal.has(t.id)) continue;
    if (t.amount > 0 && !isRefund(t)) continue;
    const merchant = merchantName(t);
    const p = cfg.places?.[placeKey(merchant)];
    const trip = tripOf.get(t.id) ?? null;
    lines.push({ ...t, date, spent: round2(-t.amount), merchant, trip, info: p?.d ?? (trip ? `Spesa della vacanza «${trip}»` : null),
      category: trip ? "viaggi" : p?.c ?? familyCategory(t), excluded: exclude.has(t.id) });
  }
  lines.sort((a, b) => (a.date === b.date ? b.spent - a.spent : a.date < b.date ? 1 : -1));
  const counted = lines.filter((l) => !l.excluded);
  const total = round2(counted.reduce((s, l) => s + l.spent, 0));
  // Mesi coperti dai dati (anche parziali), almeno uno.
  const span = Math.max(1, (new Date(today).getTime() - new Date(from).getTime()) / (30.44 * 864e5));

  const cat = new Map<FamilyCategory, { total: number; count: number }>();
  for (const l of counted) { const c = cat.get(l.category) ?? { total: 0, count: 0 }; c.total += l.spent; c.count += 1; cat.set(l.category, c); }
  const byCategory = [...cat].map(([category, v]) => ({ category, label: FAMILY_LABELS[category], total: round2(v.total), perMonth: round2(v.total / span), count: v.count }))
    .filter((c) => c.total > 0).sort((a, b) => b.total - a.total);

  const monthsList: string[] = [];
  for (let m = ym(from); m <= ym(today); m = ym(new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 1)).toISOString())) monthsList.push(m);
  const byMonth = monthsList.map((month) => {
    const row: { month: string; total: number } & Partial<Record<FamilyCategory, number>> = { month, total: 0 };
    for (const l of counted) if (ym(l.date) === month) { row[l.category] = round2((row[l.category] ?? 0) + l.spent); row.total = round2(row.total + l.spent); }
    return row;
  });

  const merch = new Map<string, { merchant: string; total: number; count: number }>();
  for (const l of counted) {
    if (l.category === "viaggi") continue;
    const k = placeKey(l.merchant).replace(/^(www )?(amazon|amzn)\b.*/, "amazon");
    const m = merch.get(k) ?? { merchant: k === "amazon" ? "Amazon" : l.merchant.replace(/\s*\d+$/, ""), total: 0, count: 0 };
    m.total += l.spent; m.count += 1; merch.set(k, m);
  }
  const topMerchants = [...merch.values()].map((m) => ({ ...m, total: round2(m.total) })).sort((a, b) => b.total - a.total).slice(0, 10);

  return { from, to: today, months: round2(span), total, perMonth: round2(total / span), count: counted.length, byCategory, byMonth, topMerchants, lines };
}
