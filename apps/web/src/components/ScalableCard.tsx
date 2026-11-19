import { useEffect, useState } from "react";
import { LineChart, RefreshCw, Unplug } from "lucide-react";
import { Card, ErrorBanner } from "./ui";
import { BankBadge } from "./BankBrand";
import { money, whenAt, date } from "../format";
import { DATA_CHANGED } from "../bankRefresh";
import {
  disconnectScalable, scalableDaysLeft, scalableHoldings, scalableStatus, startScalable, type Holding, type ScalableStatus,
} from "../scalable";

/**
 * Scalable Capital tramite il server MCP ufficiale: stato dell'accesso (scade dopo 7 giorni),
 * pulsante Collega/Rinnova e posizioni del portafoglio. I saldi compaiono tra i conti della pagina.
 */
export function ScalableCard({ busy, setBusy, onError, reloadKey }: {
  busy: string | null; setBusy: (b: string | null) => void; onError: (msg: string) => void; reloadKey: number;
}) {
  const [status, setStatus] = useState<ScalableStatus | null | undefined>(undefined);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [tick, setTick] = useState(0);
  // L'errore si mostra anche qui: sul telefono il banner in cima alla pagina resta fuori schermo.
  const [err, setErr] = useState<string | null>(null);
  const fail = (msg: string) => { setErr(msg); onError(msg); };

  useEffect(() => {
    scalableStatus().then(setStatus, () => setStatus(null));
    scalableHoldings().then(setHoldings, () => setHoldings([]));
  }, [reloadKey, tick]);
  useEffect(() => {
    const on = () => setTick((t) => t + 1);
    addEventListener(DATA_CHANGED, on);
    return () => removeEventListener(DATA_CHANGED, on);
  }, []);

  if (status === undefined) return null;
  const connected = status?.status === "active";
  const expired = status?.status === "expired";
  const days = scalableDaysLeft(status ?? null);
  const renewSoon = expired || (days !== null && days <= 1);

  const start = () => {
    setBusy("scalable"); setErr(null);
    startScalable().catch((e: Error) => { setBusy(null); fail(e.message); });
  };
  const disconnect = () => {
    if (!confirm("Scollegare Scalable? I saldi già letti restano nello storico.")) return;
    setBusy("scalable-off");
    disconnectScalable().then(() => setTick((t) => t + 1), (e: Error) => fail(e.message)).finally(() => setBusy(null));
  };

  const sub = connected
    ? `${status!.lastSyncAt ? `Letto ${whenAt(status!.lastSyncAt)}` : "Collegato"}${status!.expiresAt ? ` · accesso fino al ${date(status!.expiresAt)}` : ""}`
    : expired ? "Accesso scaduto: Scalable chiede di rientrare ogni 7 giorni"
    : "Portafoglio, liquidità e conto overnight in sola lettura, dal server MCP ufficiale di Scalable";
  const total = holdings.reduce((s, h) => s + (h.value ?? 0), 0);

  return (
    <Card title="Scalable Capital" action={<LineChart size={18} aria-hidden />}>
      <ErrorBanner message={err} />
      <ul className="list">
        <li className="row">
          <BankBadge name="Scalable Capital" />
          <span className="row-main">
            <span className="row-title">{connected ? "Collegato" : expired ? "Da rinnovare" : "Non collegato"}</span>
            <span className="row-sub">{sub}</span>
            {status?.lastError && connected && <span className="row-sub">Ultimo errore: {status.lastError}</span>}
          </span>
          <button className={`btn ${!connected || renewSoon ? "primary" : ""}`} disabled={!!busy} onClick={start}>
            <RefreshCw size={16} className={busy === "scalable" ? "spin" : ""} />{connected || expired ? "Rinnova" : "Collega Scalable"}
          </button>
          {(connected || expired) && (
            <button className="btn" disabled={!!busy} onClick={disconnect} aria-label="Scollega Scalable" title="Scollega"><Unplug size={16} /></button>
          )}
        </li>
      </ul>
      {!connected && !expired && (
        <p className="hint">Prima attiva l'accesso sul sito di Scalable: Profilo → Sicurezza → Agentic Investing, livello "Sola lettura". Poi premi "Collega Scalable" e conferma l'accesso nell'app Scalable.</p>
      )}
      {holdings.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Titolo</th><th className="right hide-sm">Quote</th><th className="right">Valore</th></tr></thead>
            <tbody>
              {holdings.map((h) => (
                <tr key={h.accountId + h.isin}>
                  <td><div className="cell-title">{h.name ?? h.isin}</div><div className="cell-sub">{h.isin}</div></td>
                  <td className="right num hide-sm">{h.quantity?.toLocaleString("it-IT", { maximumFractionDigits: 4 })}</td>
                  <td className="right num">{money(h.value, h.currency)}{total > 0 && h.value ? <div className="cell-sub">{Math.round((h.value / total) * 100)}%</div> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
