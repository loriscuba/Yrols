const eur = new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" });
const eur0 = new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });

export const money = (n: number | null | undefined, currency = "EUR") =>
  n === null || n === undefined ? "—" : currency === "EUR" ? eur.format(n) : new Intl.NumberFormat("it-IT", { style: "currency", currency }).format(n);
export const moneyShort = (n: number) => eur0.format(n);

export const todayIso = () => new Date().toISOString().slice(0, 10);

export function date(iso: string | null | undefined, opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" }) {
  if (!iso) return "—";
  const d = new Date(iso.length === 10 ? iso + "T12:00:00" : iso);
  return d.toLocaleDateString("it-IT", opts);
}

export function dateTime(iso: string | null) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("it-IT", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function daysUntil(iso: string) {
  const a = new Date(todayIso() + "T00:00:00Z").getTime();
  const b = new Date(iso.slice(0, 10) + "T00:00:00Z").getTime();
  return Math.round((b - a) / 864e5);
}

export function relDays(iso: string) {
  const n = daysUntil(iso);
  if (n === 0) return "oggi";
  if (n === 1) return "domani";
  if (n === -1) return "ieri";
  return n > 0 ? `tra ${n} giorni` : `${-n} giorni fa`;
}

export const monthLabel = (ym: string) =>
  new Date(ym + "-15T12:00:00").toLocaleDateString("it-IT", { month: "short" }).replace(".", "");

export const LABELS: Record<string, string> = {
  luce: "Luce", gas: "Gas", acqua: "Acqua", internet: "Internet", telefono: "Telefono", rifiuti: "Rifiuti (TARI)",
  condominio: "Condominio", affitto: "Affitto", mutuo: "Mutuo", altro: "Altro",
  casa: "Casa", auto: "Auto", tasse: "Tasse", assicurazione: "Assicurazione", salute: "Salute", documenti: "Documenti",
  abbonamenti: "Abbonamenti", scuola: "Scuola",
  none: "Una tantum", monthly: "Mensile", bimonthly: "Bimestrale", quarterly: "Trimestrale", semiannual: "Semestrale", yearly: "Annuale",
  bassa: "Bassa", normale: "Normale", alta: "Alta",
};
export const label = (k: string | null | undefined) => (k ? LABELS[k] ?? k : "");
