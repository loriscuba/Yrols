// Scontrini: schema della lettura, istruzioni per Claude e calcolo del risparmio.
// Codice puro, usato dalla Edge Function "yrols-scontrini" (Deno), dalla pagina Scontrini e dai test (Node).

export const CATEGORIES = ["frutta e verdura", "carne e pesce", "latte e formaggi", "dispensa", "bevande", "surgelati",
  "pulizia casa", "igiene personale", "bambini", "altro"] as const;

export interface Alternative { store: string; price: number; detail: string | null }
export interface ReceiptItem {
  description: string;        // riga come scritta sullo scontrino
  product: string;            // nome comprensibile, es. "Pannolini taglia XL (14 pz)"
  category: string;
  amount: number;             // prezzo pagato per la riga (negativo per sconti)
  alternatives: Alternative[];
}
export interface ReceiptReading {
  store: string | null; storeVat: string | null; storeAddress: string | null; chain: string | null;
  date: string | null; time: string | null; total: number | null; electronicPayment: boolean;
  items: ReceiptItem[]; tips: string[]; summary: string | null;
}
export interface GroceryPrice { store: string; product: string; detail: string | null; price: number; unit: string | null; unit_price: number | null; checked_on: string }

const str = { type: "string" } as const;
const nstr = { anyOf: [{ type: "string" }, { type: "null" }] } as const;
const nnum = { anyOf: [{ type: "number" }, { type: "null" }] } as const;

/** Schema JSON della risposta (structured outputs). */
export const READING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["store", "storeVat", "storeAddress", "chain", "date", "time", "total", "electronicPayment", "items", "tips", "summary"],
  properties: {
    store: nstr, storeVat: nstr, storeAddress: nstr, chain: nstr,
    date: nstr, time: nstr, total: nnum, electronicPayment: { type: "boolean" },
    items: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["description", "product", "category", "amount", "alternatives"],
        properties: {
          description: str, product: str, category: { type: "string", enum: [...CATEGORIES] }, amount: { type: "number" },
          alternatives: {
            type: "array",
            items: { type: "object", additionalProperties: false, required: ["store", "price", "detail"], properties: { store: str, price: { type: "number" }, detail: nstr } },
          },
        },
      },
    },
    tips: { type: "array", items: str },
    summary: nstr,
  },
} as const;

export function pricesForPrompt(prices: GroceryPrice[]): string {
  if (!prices.length) return "(listino vuoto)";
  return prices.map((p) => [p.store, p.product, p.detail ?? "", `${p.price.toFixed(2)} €`,
    p.unit_price != null && p.unit ? `${p.unit_price.toFixed(2)} €/${p.unit}` : "", `rilevato ${p.checked_on}`].join(" | ")).join("\n");
}

export const SYSTEM_PROMPT = `Leggi la foto di uno scontrino italiano e aiuta a capire se la stessa spesa costava meno in un altro supermercato della zona (Savona).

Lettura:
- store: ragione sociale come stampata; chain: insegna o catena se si capisce (es. "Ekom" da righe come "SHOPPER BIO EKOM"), altrimenti null.
- date in formato AAAA-MM-GG, time in HH:MM, total = TOTALE COMPLESSIVO in euro. electronicPayment = true se pagato con carta/bancomat ("PAGAMENTO ELETTRONICO").
- items: una voce per riga di prodotto, nell'ordine dello scontrino, con il prezzo della riga. Sconti e buoni sono voci con importo negativo (category "altro"). Attenzione: su molti scontrini la colonna dei prezzi è sfalsata di una riga rispetto alle descrizioni; la somma delle voci deve fare il totale.
- product: nome chiaro in italiano che spiega le abbreviazioni (es. "IG.X6 2V" = carta igienica 6 rotoli 2 veli).

Confronto (alternatives):
- Usa SOLO i prezzi del listino che ricevi. Non inventare prezzi.
- Per ogni prodotto indica le catene del listino che vendono un prodotto equivalente (stesso tipo, formato simile; marca del distributore va bene) con il prezzo riportato alla stessa quantità dello scontrino; detail spiega in poche parole cosa hai confrontato (es. "Lidl, carta igienica 8 rotoli, riportata a 6").
- Se lo scontrino non dice il peso di un prodotto sfuso, non confrontarlo. Se non c'è un equivalente, alternatives è vuoto. Non mettere come alternativa la stessa catena dello scontrino.

tips: da 2 a 4 consigli pratici e brevi in italiano, legati a questa spesa (dove conviene comprare cosa, marche del distributore, offerte). Se un consiglio non viene dal listino ma da conoscenza generale, dillo ("in genere…").
summary: una frase sul risultato del confronto.`;

const round = (n: number) => Math.round(n * 100) / 100;
const text = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? round(v) : null);

/** Pulisce la risposta: tipi giusti, date valide, niente alternative che costano di più o a prezzo zero. */
export function normalizeReading(raw: unknown): ReceiptReading {
  const r = (raw ?? {}) as Record<string, unknown>;
  const date = text(r.date, 10);
  const time = text(r.time, 5);
  const items: ReceiptItem[] = (Array.isArray(r.items) ? r.items : []).flatMap((x) => {
    const i = (x ?? {}) as Record<string, unknown>;
    const amount = num(i.amount);
    const description = text(i.description, 120);
    if (amount == null || !description) return [];
    const alternatives = (Array.isArray(i.alternatives) ? i.alternatives : []).flatMap((a) => {
      const o = (a ?? {}) as Record<string, unknown>;
      const store = text(o.store, 60), price = num(o.price);
      return store && price != null && price > 0 ? [{ store, price, detail: text(o.detail, 160) }] : [];
    });
    const category = typeof i.category === "string" && (CATEGORIES as readonly string[]).includes(i.category) ? i.category : "altro";
    return [{ description, product: text(i.product, 120) ?? description, category, amount, alternatives: amount > 0 ? alternatives : [] }];
  });
  return {
    store: text(r.store, 120), storeVat: text(r.storeVat, 20), storeAddress: text(r.storeAddress, 160), chain: text(r.chain, 60),
    date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date)) ? date : null,
    time: time && /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : null,
    total: num(r.total) != null && num(r.total)! > 0 ? num(r.total) : null,
    electronicPayment: r.electronicPayment === true,
    items,
    tips: (Array.isArray(r.tips) ? r.tips : []).map((t) => text(t, 400)).filter((t): t is string => !!t).slice(0, 5),
    summary: text(r.summary, 400),
  };
}

export interface StoreBasket { store: string; total: number; saving: number; covered: number }
export interface Savings {
  paid: number;
  /** Per prodotto: l'alternativa più economica, se costa meno di quanto pagato. */
  cheaper: { product: string; paid: number; store: string; price: number; saving: number; detail: string | null }[];
  /** Spesa se avessi comprato in quella catena i prodotti che ha a listino (il resto al prezzo pagato). */
  stores: StoreBasket[];
  /** Comprando ogni prodotto dove costa meno (più negozi). */
  bestMix: number;
}

export function savings(items: ReceiptItem[]): Savings {
  const paid = round(items.reduce((s, i) => s + i.amount, 0));
  const cheaper = items.flatMap((i) => {
    const best = [...i.alternatives].sort((a, b) => a.price - b.price)[0];
    return best && best.price < i.amount ? [{ product: i.product, paid: i.amount, store: best.store, price: best.price, saving: round(i.amount - best.price), detail: best.detail }] : [];
  }).sort((a, b) => b.saving - a.saving);
  const names = [...new Set(items.flatMap((i) => i.alternatives.map((a) => a.store)))];
  const stores = names.map((store) => {
    let total = 0, covered = 0;
    for (const i of items) {
      const alt = i.alternatives.filter((a) => a.store === store).sort((a, b) => a.price - b.price)[0];
      if (alt) covered++;
      total += alt ? alt.price : i.amount;
    }
    return { store, total: round(total), saving: round(paid - total), covered };
  }).sort((a, b) => b.saving - a.saving);
  return { paid, cheaper, stores, bestMix: round(cheaper.reduce((s, c) => s + c.saving, 0)) };
}
