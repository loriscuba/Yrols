/**
 * Riconosce bollette e scadenze nelle email (euristiche pensate per i fornitori italiani).
 * Funzione pura: nessun accesso alla rete, facile da testare.
 */
export interface ParsedEmail { from: string; subject: string; text: string; date?: Date }
export interface Suggestion {
  kind: "bill" | "deadline";
  provider: string | null;
  billKind: string | null;
  title: string;
  amount: number | null;
  dueDate: string | null;
  snippet: string;
}

const PROVIDERS: [RegExp, string, string][] = [
  [/\benel\b/i, "Enel Energia", "luce"],
  [/plenitude|\beni\b/i, "Eni Plenitude", "gas"],
  [/\ba2a\b/i, "A2A", "luce"],
  [/\bhera\b/i, "Hera", "gas"],
  [/\biren\b/i, "Iren", "gas"],
  [/\bacea\b/i, "Acea", "acqua"],
  [/edison/i, "Edison", "luce"],
  [/sorgenia/i, "Sorgenia", "luce"],
  [/illumia/i, "Illumia", "luce"],
  [/octopus/i, "Octopus Energy", "luce"],
  [/servizio elettrico nazionale/i, "Servizio Elettrico Nazionale", "luce"],
  [/\btim\b|telecom italia/i, "TIM", "internet"],
  [/vodafone/i, "Vodafone", "telefono"],
  [/wind\s?tre|windtre/i, "WindTre", "telefono"],
  [/iliad/i, "Iliad", "telefono"],
  [/fastweb/i, "Fastweb", "internet"],
  [/\bsky\b/i, "Sky", "internet"],
  [/acquedotto|\babbanoa\b|\bsmat\b|gruppo cap|metropolitana milanese|publiacqua/i, "Servizio idrico", "acqua"],
  [/\btari\b|rifiuti/i, "TARI", "rifiuti"],
  [/condominio|amministrazione condominiale/i, "Condominio", "condominio"],
];

const BILL_WORDS = /bollett|fattura|importo da pagare|totale da pagare|addebito|rata|pagamento.*entro/i;
const DEADLINE_RULES: [RegExp, string][] = [
  [/bollo auto|tassa automobilistica/i, "Bollo auto"],
  [/revisione/i, "Revisione auto"],
  [/rc ?auto|polizza|assicurazion|rinnovo.*copertura/i, "Rinnovo assicurazione"],
  [/\bimu\b/i, "IMU"],
  [/\bf24\b/i, "Pagamento F24"],
  [/730|dichiarazione dei redditi/i, "Dichiarazione dei redditi"],
  [/carta d'identit|passaporto|patente/i, "Rinnovo documento"],
  [/canone rai/i, "Canone RAI"],
  [/abbonamento.*(scad|rinnov)|(scad|rinnov).*abbonamento/i, "Rinnovo abbonamento"],
];
const NOISE = /newsletter|offerta|promo|sconto|webinar|unsubscribe.*offert/i;

const MONTHS: Record<string, number> = {
  gennaio: 1, febbraio: 2, marzo: 3, aprile: 4, maggio: 5, giugno: 6,
  luglio: 7, agosto: 8, settembre: 9, ottobre: 10, novembre: 11, dicembre: 12,
};

/** "1.234,56" → 1234.56 ; "82.10" → 82.1 */
export function parseItalianAmount(s: string): number | null {
  const t = s.replace(/\s/g, "");
  let n: number;
  if (/,\d{1,2}$/.test(t)) n = Number(t.replace(/\./g, "").replace(",", "."));
  else if (/\.\d{1,2}$/.test(t)) n = Number(t.replace(/,/g, ""));
  else n = Number(t.replace(/[.,]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

const AMOUNT_RE = /(?:€|eur(?:o)?)\s*(\d{1,3}(?:[.\s]\d{3})*(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)|(\d{1,3}(?:\.\d{3})*,\d{2}|\d+[.,]\d{2})\s*(?:€|eur(?:o)?\b)/gi;
const KEY_AMOUNT = /(totale|importo|da pagare|addebit|saldo|rata|ammontare)/i;

export function findAmount(text: string): number | null {
  let best: { v: number; score: number } | null = null;
  for (const m of text.matchAll(AMOUNT_RE)) {
    const v = parseItalianAmount(m[1] ?? m[2]);
    if (v === null) continue;
    const before = text.slice(Math.max(0, m.index! - 60), m.index!);
    const score = KEY_AMOUNT.test(before) ? 2 : 1;
    if (!best || score > best.score) best = { v, score };
  }
  return best?.v ?? null;
}

function toIso(y: number, m: number, d: number) {
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

const DATE_RE = /(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})|(\d{1,2})\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\s+(\d{4})/gi;
const KEY_DUE = /(scadenz|scade|entro (il|e non oltre)?|da pagare entro|data (di )?addebito|verrà addebitat|pagare entro)/i;

export function findDueDate(text: string): string | null {
  let fallback: string | null = null;
  for (const m of text.matchAll(DATE_RE)) {
    const iso = m[1] ? toIso(+m[3], +m[2], +m[1]) : toIso(+m[6], MONTHS[m[5].toLowerCase()], +m[4]);
    if (!iso) continue;
    const before = text.slice(Math.max(0, m.index! - 50), m.index!);
    if (KEY_DUE.test(before)) return iso;
    fallback ??= iso;
  }
  return fallback;
}

function senderName(from: string) {
  const name = from.replace(/<[^>]+>/, "").replace(/"/g, "").trim();
  if (name && !name.includes("@")) return name;
  const domain = from.match(/@([\w-]+)\./)?.[1];
  return domain ? domain.charAt(0).toUpperCase() + domain.slice(1) : null;
}

export function parseEmail(e: ParsedEmail): Suggestion | null {
  const head = `${e.subject}\n${e.from}`;
  const all = `${e.subject}\n${e.text}`.replace(/ /g, " ");
  if (NOISE.test(e.subject)) return null;
  const snippet = e.text.replace(/\s+/g, " ").trim().slice(0, 240);

  for (const [re, title] of DEADLINE_RULES) {
    if (re.test(head) || (re.test(all) && /scad|rinnov|entro/i.test(all))) {
      return { kind: "deadline", provider: senderName(e.from), billKind: null, title, amount: findAmount(all), dueDate: findDueDate(all), snippet };
    }
  }

  if (!BILL_WORDS.test(all)) return null;
  const known = PROVIDERS.find(([re]) => re.test(head)) ?? PROVIDERS.find(([re]) => re.test(all));
  const amount = findAmount(all);
  const dueDate = findDueDate(all);
  if (amount === null && dueDate === null) return null;
  const provider = known?.[1] ?? senderName(e.from);
  return {
    kind: "bill",
    provider,
    billKind: known?.[2] ?? "altro",
    title: `Bolletta ${provider ?? ""}`.trim(),
    amount,
    dueDate,
    snippet,
  };
}
