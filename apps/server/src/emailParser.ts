/**
 * Riconosce bollette e scadenze nelle email (euristiche pensate per i fornitori italiani).
 * Funzione pura: nessun accesso alla rete, facile da testare.
 */
export interface PdfAttachment { filename: string; content: Uint8Array }
export interface ParsedEmail { from: string; subject: string; text: string; date?: Date; pdfs?: PdfAttachment[] }
export interface Suggestion {
  kind: "bill" | "deadline";
  provider: string | null;
  billKind: string | null;
  title: string;
  amount: number | null;
  dueDate: string | null;
  snippet: string;
}

export const PROVIDERS: [RegExp, string, string][] = [
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
const NOISE = /newsletter|offert|promo|sconto|buono|coupon|convenienza|webinar|unsubscribe.*offert|prenotazion|appuntamento|aggiornamento (?:del|sul) servizio|service update|termini|condizioni|novità|acquistal|scopri|vinci|regalo|cashback|\bordin[ea]|\bordinat|spedit|consegn|pacco|ritiro|annunc|conferma (?:di |d[ie]l?l?'?)?\s*(?:acquisto|ordine)|riepilogo (?:giornaliero|settimanale)/i;
// Mittenti di marketing: news.paypal.com, remind.facile.it, marketing@…, promo@…
// Negozi online, consegne, annunci e newsletter: ricevute d'ordine e riepiloghi, non bollette.
const SHOP_SENDER = /amazon|deliveroo|just ?eat|glovo|ebay|zalando|idealista|immobiliare\.it|ticketone|substack|booking\.com|airbnb|vinted|subito\.it/i;
const NOISE_SENDER = /@(?:[\w-]+\.)*(?:news|newsletter|marketing|promo|promozioni|remind|offerte|info-?mail)\.|(?:^|[<\s"])(?:news|newsletter|marketing|promo|offerte)@/i;

/** Pubblicità, newsletter e comunicazioni di servizio: si riconoscono da oggetto e mittente. */
export const isNoise = (from: string, subject: string) => NOISE.test(subject) || NOISE_SENDER.test(from) || SHOP_SENDER.test(from);

/** Testo leggibile da una mail HTML: niente stili, script e tag. */
export function htmlToText(html: string): string {
  return html.replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&euro;/g, "€").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

/** Anteprima pulita: senza CSS rimasto nel testo, indirizzi web e link tra parentesi. */
export function cleanSnippet(text: string, max = 240): string {
  return text
    .replace(/[^{}\n]{0,200}\{[^{}]*\}/g, " ")                          // regole CSS "body { … }"
    .replace(/\[?\(?(?:https?:\/\/|www\.)[^\s)\]]+[)\]]?/gi, " ")         // URL, anche "(https://…)" e "[https://…]"
    .replace(/\[\s*\]|\(\s*\)/g, " ")
    .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, "$1")
    .replace(/\s+/g, " ").trim().slice(0, max);
}

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
// "Scadenza condizioni economiche / offerta / contratto" non è una scadenza di pagamento.
const NOT_DUE = /scadenza\s+(?:delle\s+)?(?:condizioni|offert|contratt|prezz|promo)[^\n]*\n?[^\n]*$/i;
const KEY_DUE = /(scadenz|scade|entro (il|e non oltre)?|da pagare entro|data (di )?addebito|verrà addebitat|pagare entro)/i;

/** Data di scadenza; con onlyKeyed solo se preceduta da "scadenza", "entro il", "addebito"… */
export function findDueDate(text: string, onlyKeyed = false): string | null {
  let fallback: string | null = null;
  for (const m of text.matchAll(DATE_RE)) {
    const iso = m[1] ? toIso(+m[3], +m[2], +m[1]) : toIso(+m[6], MONTHS[m[5].toLowerCase()], +m[4]);
    if (!iso) continue;
    const before = text.slice(Math.max(0, m.index! - 50), m.index!);
    if (KEY_DUE.test(before) && !NOT_DUE.test(before)) return iso;
    fallback ??= iso;
  }
  return onlyKeyed ? null : fallback;
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
  if (isNoise(e.from, e.subject)) return null;
  const snippet = cleanSnippet(e.text);

  for (const [re, title] of DEADLINE_RULES) {
    // Nell'oggetto basta la parola chiave; se compare solo nel testo serve una vera data di scadenza.
    if (re.test(head) || (re.test(all) && findDueDate(all, true))) {
      return { kind: "deadline", provider: senderName(e.from), billKind: null, title, amount: findAmount(all), dueDate: findDueDate(all), snippet };
    }
  }

  const known = PROVIDERS.find(([re]) => re.test(head)) ?? PROVIDERS.find(([re]) => re.test(all));
  // Da un mittente sconosciuto, "bolletta" o "fattura" devono stare nell'oggetto: nel solo testo compaiono anche nelle ricevute d'ordine.
  if (!BILL_WORDS.test(known ? all : e.subject)) return null;
  const amount = findAmount(all);
  const dueDate = findDueDate(all);
  // Una bolletta vera ha un importo, oppure è di un fornitore noto con una scadenza esplicita.
  if (amount === null && !(known && findDueDate(all, true))) return null;
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

/** PDF allegati a un messaggio (mailparser), al massimo 3 e 10 MB l'uno: sono le fatture da leggere. */
export function pdfAttachments(parsed: { attachments?: { filename?: string; contentType?: string; content: Uint8Array; size?: number }[] }): PdfAttachment[] {
  return (parsed.attachments ?? [])
    .filter((a) => (a.contentType === "application/pdf" || /\.pdf$/i.test(a.filename ?? "")) && a.content.byteLength <= 10 * 1024 * 1024)
    .slice(0, 3)
    .map((a) => ({ filename: a.filename ?? "fattura.pdf", content: new Uint8Array(a.content) }));
}
