/**
 * Risparmio: mette a confronto la spesa attuale per ogni utenza con le offerte trovate dal controllo settimanale.
 * Logica pura, senza database: la usa il cruscotto web e la provano i test.
 *
 * La spesa attuale di una voce si prende, in ordine: da quella indicata dal controllo settimanale sull'offerta
 * (che sa separare luce e gas di uno stesso fornitore), dall'anagrafica fornitori, dai pagamenti ricorrenti.
 */

export const SAVING_CATEGORIES = ["luce", "gas", "internet", "telefono", "abbonamenti"] as const;
export type SavingCategory = (typeof SAVING_CATEGORIES)[number];

export const CATEGORY_LABEL: Record<SavingCategory, string> = {
  luce: "Luce", gas: "Gas", internet: "Internet casa", telefono: "Telefonia mobile", abbonamenti: "Abbonamenti",
};

export interface SavingOffer {
  id: number; category: SavingCategory; provider: string; name: string; priceType: "fisso" | "variabile" | null;
  monthlyCost: number; currentMonthly: number | null; currentProvider: string | null;
  priceDetails: string | null; conditions: string | null; url: string | null; source: string;
  validUntil: string | null; status: "nuova" | "vista" | "nascosta"; active: boolean; firstSeen: string; lastSeen: string;
}

/** Voce di spesa attuale. */
export interface CurrentSpend { category: SavingCategory; provider: string; monthly: number; from: "controllo" | "fornitori" | "movimenti" }

/** Scheda dell'anagrafica fornitori (tabella yrols.suppliers), solo i campi che servono qui. */
export interface SupplierLite { name: string; kind: string; monthly: number | null; status?: string | null }
/** Pagamento ricorrente riconosciuto dai movimenti (vedi recurring.ts), solo i campi che servono qui. */
export interface RecurringLite { label: string; monthly: number }

const KIND_TO_CATEGORY: Partial<Record<string, SavingCategory>> = { luce: "luce", gas: "gas", internet: "internet", telefono: "telefono" };

/** Riconoscimento di ripiego dal nome, finché l'anagrafica fornitori non c'è. */
const PATTERNS: [RegExp, SavingCategory | "energia"][] = [
  [/\b(fastweb|tiscali|eolo|open ?fiber|sky wifi|linkem|aruba fibra|tim fibra)\b/i, "internet"],
  [/\b(iliad|ho\.? ?mobile|kena|very ?mobile|wind ?tre|windtre|vodafone|tim\b|poste ?mobile|coopvoce|fastweb mobile|spusu|lyca)/i, "telefono"],
  [/\b(sorgenia|enel energia|a2a|hera|iren|edison|plenitude|eni gas|octopus|acea energia|engie|illumia|e\.on|nen\b|pulsee|wekiwi|servizio elettrico)/i, "energia"],
  [/\b(amazon prime|netflix|spotify|disney|dazn|now tv|sky\b|apple\.com|youtube premium|paramount)/i, "abbonamenti"],
];

export function guessCategory(name: string): SavingCategory | "energia" | null {
  for (const [re, c] of PATTERNS) if (re.test(name)) return c;
  return null;
}

/** Spesa attuale per voce, dalla fonte migliore disponibile. Un fornitore di luce e gas insieme conta su entrambe. */
export function currentSpend(offers: SavingOffer[], suppliers: SupplierLite[] | null, recurring: RecurringLite[]): CurrentSpend[] {
  const out = new Map<SavingCategory, CurrentSpend>();
  // 1. Il controllo settimanale indica la spesa attuale con cui ha confrontato: è la più precisa.
  for (const o of offers) {
    if (o.currentMonthly == null || out.has(o.category)) continue;
    out.set(o.category, { category: o.category, provider: o.currentProvider ?? "Fornitore attuale", monthly: o.currentMonthly, from: "controllo" });
  }
  // 2. Anagrafica fornitori (se presente), poi 3. pagamenti ricorrenti.
  const add = (category: SavingCategory, provider: string, monthly: number, from: CurrentSpend["from"]) => {
    const cur = out.get(category);
    if (cur && cur.from !== from) return;
    if (cur) { cur.monthly += monthly; if (!cur.provider.includes(provider)) cur.provider += ` + ${provider}`; }
    else out.set(category, { category, provider, monthly, from });
  };
  const fromSuppliers = (suppliers ?? []).filter((s) => s.status !== "nascosto" && s.monthly && s.monthly > 0);
  for (const s of fromSuppliers) {
    const c: SavingCategory | "energia" | null = KIND_TO_CATEGORY[s.kind] ?? (s.kind === "altro" ? guessCategory(s.name) : null);
    if (c === "energia") continue; // luce e gas insieme: senza separazione non si confronta, lo fa il controllo
    if (c) add(c, s.name, s.monthly!, "fornitori");
  }
  for (const r of recurring) {
    const c = guessCategory(r.label);
    if (!c || c === "energia" || r.monthly <= 0) continue;
    add(c, r.label, r.monthly, "movimenti");
  }
  return SAVING_CATEGORIES.flatMap((c) => (out.has(c) ? [round2(out.get(c)!)] : []));
}

export interface CategorySummary {
  category: SavingCategory; label: string; current: CurrentSpend | null;
  offers: (SavingOffer & { saving: number | null })[];
  best: (SavingOffer & { saving: number | null }) | null;
  /** Risparmio mensile con l'offerta migliore (0 se nessuna offerta conviene, null se la spesa attuale non è nota). */
  monthlySaving: number | null;
}

/** Offerte attive e non nascoste per voce, dalla più economica, con il risparmio rispetto alla spesa attuale. */
export function summarize(offers: SavingOffer[], current: CurrentSpend[], showHidden = false): CategorySummary[] {
  const curBy = new Map(current.map((c) => [c.category, c]));
  return SAVING_CATEGORIES.map((category) => {
    const cur = curBy.get(category) ?? null;
    const list = offers
      .filter((o) => o.category === category && o.active && (showHidden || o.status !== "nascosta"))
      .map((o) => {
        const base = o.currentMonthly ?? cur?.monthly ?? null;
        return { ...o, saving: base == null ? null : round(base - o.monthlyCost) };
      })
      .sort((a, b) => a.monthlyCost - b.monthlyCost || a.provider.localeCompare(b.provider));
    const best = list.find((o) => o.status !== "nascosta") ?? null;
    const monthlySaving = best?.saving == null ? null : Math.max(0, best.saving);
    return { category, label: CATEGORY_LABEL[category], current: cur, offers: list, best, monthlySaving };
  }).filter((s) => s.current || s.offers.length);
}

const round = (n: number) => Math.round(n * 100) / 100;
const round2 = (c: CurrentSpend): CurrentSpend => ({ ...c, monthly: round(c.monthly) });
