import { useEffect, useState } from "react";
import { PiggyBank, Pencil } from "lucide-react";
import { Card, ErrorBanner, Field, Modal } from "./ui";
import { BankBadge } from "./BankBrand";
import { date, money } from "../format";
import { DATA_CHANGED } from "../bankRefresh";
import { fundFigures, listFunds, updateFund, type Fund, type PacPurchase } from "../funds";

const q3 = (n: number) => n.toLocaleString("it-IT", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const pct = (n: number) => `${n > 0 ? "+" : ""}${n.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;

/**
 * Fondi senza API (PAC Fineco): quote, valore al NAV pubblico più recente, guadagno e rate del PAC.
 * Il valore è anche tra i conti della pagina e nel patrimonio.
 */
export function FundCard({ reloadKey, onChanged }: { reloadKey: number; onChanged: () => void }) {
  const [data, setData] = useState<{ funds: Fund[]; purchases: PacPurchase[] } | null>(null);
  const [tick, setTick] = useState(0);
  const [edit, setEdit] = useState<Fund | null>(null);
  useEffect(() => { listFunds().then(setData, () => setData(null)); }, [reloadKey, tick]);
  useEffect(() => {
    const on = () => setTick((t) => t + 1);
    addEventListener(DATA_CHANGED, on);
    return () => removeEventListener(DATA_CHANGED, on);
  }, []);
  if (!data?.funds.length) return null;

  return (
    <Card title={data.funds.length === 1 ? "Fondo Fineco" : "Fondi"} action={<PiggyBank size={18} aria-hidden />}>
      {data.funds.map((f) => {
        const { value, gain, gainPct, avgPrice } = fundFigures(f);
        const buys = data.purchases.filter((p) => p.fundId === f.id).slice(0, 3);
        return (
          <div key={f.id} className="fund">
            <ul className="list">
              <li className="row">
                <BankBadge name={f.bankName} />
                <span className="row-main">
                  <span className="row-title">{f.name}</span>
                  <span className="row-sub">{f.isin}{f.lastNavDate ? ` · NAV ${f.lastNav?.toLocaleString("it-IT", { maximumFractionDigits: 4 })} € del ${date(f.lastNavDate)}` : " · in attesa del primo NAV"}</span>
                </span>
                <span className="right">
                  <span className="num">{money(value)}</span>
                  {gain !== null && <div className={`cell-sub num ${gain >= 0 ? "pos" : "tone-critical"}`}>{gain >= 0 ? "+" : ""}{money(gain)}{gainPct !== null ? ` · ${pct(gainPct)}` : ""}</div>}
                </span>
                <button className="btn" onClick={() => setEdit(f)} aria-label="Correggi i dati del fondo" title="Correggi"><Pencil size={16} /></button>
              </li>
            </ul>
            <dl className="fund-facts">
              <div><dt>Quote</dt><dd className="num">{q3(f.quantity)}</dd></div>
              <div><dt>Prezzo medio</dt><dd className="num">{avgPrice ? avgPrice.toLocaleString("it-IT", { maximumFractionDigits: 3 }) : "—"}</dd></div>
              <div><dt>Valore di carico</dt><dd className="num">{money(f.cost)}</dd></div>
              <div><dt>PAC</dt><dd>{f.pacAmount > 0 && f.pacDay ? `${money(f.pacAmount)} il ${f.pacDay} del mese` : "Fermo"}</dd></div>
              <div><dt>Rate pagate</dt><dd className="num">{f.pacPaid}{f.pacTotal ? ` di ${f.pacTotal}` : ""}</dd></div>
              {f.pacAmount > 0 && f.pacNext && <div><dt>Prossima rata</dt><dd>{date(f.pacNext)}</dd></div>}
            </dl>
            {buys.length > 0 && (
              <p className="hint">Ultime rate contate: {buys.map((b) => `${date(b.dueDate, { day: "numeric", month: "short" })} ${q3(b.quantity)} quote a ${b.nav.toLocaleString("it-IT")} €`).join(" · ")}</p>
            )}
          </div>
        );
      })}
      <p className="hint">Il NAV si legge ogni giorno dalle pagine pubbliche del fondo ed esce con 1-2 giorni di ritardo. Ogni rata del PAC compra quote al primo NAV dal giorno del pagamento: se Fineco mostra numeri diversi, correggili con la matita.</p>
      {edit && <FundEdit fund={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); setTick((t) => t + 1); onChanged(); }} />}
    </Card>
  );
}

function FundEdit({ fund, onClose, onSaved }: { fund: Fund; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState({
    quantity: String(fund.quantity), cost: String(fund.cost), pacAmount: String(fund.pacAmount),
    pacDay: String(fund.pacDay ?? ""), pacPaid: String(fund.pacPaid), pacTotal: String(fund.pacTotal ?? ""),
  });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // "6.731,80" e "6731.80" valgono uguale; con la virgola il punto separa le migliaia.
  const num = (s: string) => {
    const t = s.trim().replace(/\s|€/g, "");
    const n = Number(t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t);
    return t && Number.isFinite(n) ? n : undefined;
  };
  const f = (k: keyof typeof v, label: string, hint?: string) => (
    <Field label={label}><input inputMode="decimal" value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} placeholder={hint} /></Field>
  );
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const day = num(v.pacDay);
    if (day !== undefined && (day < 1 || day > 28)) { setErr("Il giorno del PAC va da 1 a 28"); return; }
    setBusy(true); setErr(null);
    updateFund(fund.id, { quantity: num(v.quantity), cost: num(v.cost), pacAmount: num(v.pacAmount), pacDay: day, pacPaid: num(v.pacPaid), pacTotal: num(v.pacTotal) })
      .then(onSaved, (x: Error) => { setErr(x.message); setBusy(false); });
  };
  return (
    <Modal title="Correggi il fondo" onClose={onClose}>
      <form className="form" onSubmit={save}>
        <p className="hint wide">Copia i valori dalla sezione Portafoglio dell'app Fineco. Da qui in poi si contano solo le rate future.</p>
        {f("quantity", "Quote", "es. 46,542")}
        {f("cost", "Valore di carico (€)")}
        {f("pacAmount", "Rata PAC (€, 0 se fermo)")}
        {f("pacDay", "Giorno del pagamento")}
        {f("pacPaid", "Rate pagate")}
        {f("pacTotal", "Rate totali")}
        <ErrorBanner message={err} />
        <div className="form-actions wide">
          <button type="button" className="btn" onClick={onClose}>Annulla</button>
          <button className="btn primary" disabled={busy}>Salva</button>
        </div>
      </form>
    </Modal>
  );
}
