import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, KeyRound, Landmark, Plus, RefreshCw, Search } from "lucide-react";
import { useData } from "../hooks";
import type { Account, Connection, Transaction } from "../api";
import { date, daysUntil, money, dateTime } from "../format";
import { Card, DueBadge, Empty, ErrorBanner, Modal, Stat } from "../components/ui";
import { bankAuthAvailable, completeBankAuth, listBanks, startBankAuth, type BankOption } from "../bankAuth";

type Notice = { kind: "ok" | "error"; text: string; retry30?: { bankName: string; country: string } };

export function BanksPage() {
  const accounts = useData<Account[]>("/banks/accounts");
  const connections = useData<Connection[]>("/banks/connections");
  const lastSync = useData<{ receivedAt: string; source: string } | null>("/banks/last-sync");
  const [accountId, setAccountId] = useState("");
  const [q, setQ] = useState("");
  const params = new URLSearchParams({ limit: "300", ...(accountId && { accountId }), ...(q.length > 1 && { q }) });
  const txs = useData<Transaction[]>(`/banks/transactions?${params}`);
  // Consensi solo per le banche con almeno un conto (una banca collegata e poi abbandonata non conta).
  const activeConnections = useMemo(() => {
    const used = new Set((accounts.data ?? []).map((a) => a.connectionId));
    return (connections.data ?? []).filter((c) => c.status !== "revoked" && used.has(c.id));
  }, [accounts.data, connections.data]);
  // I sottoconti a saldo zero (es. valute non usate) non si mostrano.
  const visible = useMemo(() => (accounts.data ?? []).filter((a) => (a.balance ?? 0) !== 0 || a.id === accountId), [accounts.data, accountId]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const online = bankAuthAvailable();
  const reloadAll = () => { accounts.reload(); connections.reload(); lastSync.reload(); txs.reload(); };

  const start = (opts: Parameters<typeof startBankAuth>[0], key: string) => {
    setBusy(key); setNotice(null);
    startBankAuth(opts).catch((e: Error) => { setBusy(null); setNotice({ kind: "error", text: e.message }); });
  };

  // Ritorno dalla banca: /banche?eb_state=…&eb_code=… (oppure eb_error). Si completa una sola volta.
  const handled = useRef(false);
  useEffect(() => {
    if (!online || handled.current) return;
    const qs = new URLSearchParams(location.search);
    const state = qs.get("eb_state");
    if (!state) return;
    handled.current = true;
    const code = qs.get("eb_code") ?? undefined;
    const err = qs.get("eb_error") ?? undefined;
    history.replaceState(null, "", location.pathname);
    setBusy("complete");
    completeBankAuth({ state, code, error: err }).then((r) => {
      if (r.error) {
        const text = r.error === "no_accounts"
          ? `${r.bankName}: nessun conto condiviso. Attiva i conti nell'app della banca (sezione Open Banking) e ricollega.`
          : r.error === "invalid_request"
            ? `${r.bankName} non ha accettato la durata del consenso.`
            : `${r.bankName}: collegamento non riuscito (${r.error}).`;
        setNotice({ kind: "error", text, retry30: r.error === "invalid_request" ? { bankName: r.bankName, country: r.country } : undefined });
      } else {
        const n = r.accounts?.length ?? 0;
        setNotice({ kind: "ok", text: `${r.bankName} collegata: ${n} ${n === 1 ? "conto" : "conti"}${r.validUntil ? `, consenso valido fino al ${date(r.validUntil)}` : ""}.` });
      }
      reloadAll();
    }, (e: Error) => setNotice({ kind: "error", text: e.message })).finally(() => setBusy(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online]);

  const total = useMemo(() => (accounts.data ?? []).reduce((s, a) => s + (a.balance ?? 0), 0), [accounts.data]);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Banche</h1>
          <p className="sub">{lastSync.data ? `Ultimo aggiornamento ${dateTime(lastSync.data.receivedAt)}` : "Dati dal connettore Enable Banking"}</p>
        </div>
        {online && <button className="btn primary" onClick={() => setPicker(true)}><Plus size={16} />Collega banca</button>}
      </header>
      <ErrorBanner message={accounts.error ?? txs.error} />
      {busy === "complete" && <div className="banner info"><RefreshCw size={16} className="spin" aria-hidden />Completo il collegamento e scarico i movimenti…</div>}
      {notice && (
        <div className={`banner ${notice.kind === "ok" ? "info" : "critical"}`} role="status">
          {notice.kind === "ok" ? <CheckCircle2 size={16} aria-hidden /> : null}
          <span style={{ flex: 1 }}>{notice.text}</span>
          {notice.retry30 && (
            <button className="btn" onClick={() => start({ ...notice.retry30!, consentDays: 30 }, "retry")} disabled={!!busy}>Riprova con consenso di 30 giorni</button>
          )}
        </div>
      )}
      {accounts.data && accounts.data.length === 0 ? (
        <Card>
          <Empty icon={<Landmark />} title="Nessun conto collegato">
            {online ? "Usa “Collega banca” per dare il consenso dalla tua banca: i conti compariranno qui subito dopo."
              : <>Avvia il connettore Enable Banking e impostagli l'indirizzo di questo cruscotto e il token <code>YROLS_INGEST_TOKEN</code>: i conti compariranno qui alla prima sincronizzazione.</>}
          </Empty>
        </Card>
      ) : (
        <>
          <div className="stats">
            <Stat label="Totale sui conti" value={money(total)} />
            {visible.map((a) => (
              <button key={a.id} className={`stat stat-btn ${accountId === a.id ? "on" : ""}`} onClick={() => setAccountId(accountId === a.id ? "" : a.id)}>
                <div className="stat-label">{a.bankName ?? "Banca"} · {a.name ?? a.iban ?? a.id}</div>
                <div className="stat-value">{money(a.balance, a.currency)}</div>
                <div className="stat-hint">{a.iban ? `…${a.iban.slice(-4)}` : ""}{a.balanceDate ? ` · saldo al ${date(a.balanceDate)}` : ""}</div>
              </button>
            ))}
          </div>

          {activeConnections.length > 0 && (
            <Card title="Banche collegate">
              <ul className="list">
                {activeConnections.map((c) => {
                  const expiring = !!c.validUntil && daysUntil(c.validUntil) <= 14;
                  return (
                    <li key={c.id} className="row">
                      <span className="row-icon"><KeyRound size={16} aria-hidden /></span>
                      <span className="row-main">
                        <span className="row-title">{c.bankName ?? c.id}</span>
                        <span className="row-sub">{c.validUntil ? `Consenso valido fino al ${date(c.validUntil)}` : "Consenso attivo"}</span>
                      </span>
                      {c.validUntil && <DueBadge date={c.validUntil.slice(0, 10)} />}
                      {online && c.bankName && (
                        <button className={`btn ${expiring ? "primary" : ""}`} disabled={!!busy}
                          onClick={() => start({ bankName: c.bankName!, country: c.country ?? "IT", replaces: c.id }, c.id)}>
                          <RefreshCw size={16} className={busy === c.id ? "spin" : ""} />Rinnova
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}

          <Card title="Movimenti" action={
            <div className="search"><Search size={16} aria-hidden /><input placeholder="Cerca movimenti" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Cerca movimenti" /></div>
          }>
            {txs.data?.length === 0 ? <Empty icon={<Search />} title="Nessun movimento trovato" /> : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Data</th><th>Descrizione</th><th className="hide-sm">Conto</th><th className="right">Importo</th></tr></thead>
                  <tbody>
                    {txs.data?.map((t) => (
                      <tr key={t.accountId + t.id}>
                        <td className="nowrap">{date(t.bookingDate, { day: "2-digit", month: "short" })}</td>
                        <td><div className="cell-title">{t.counterparty ?? t.description}</div>{t.counterparty && <div className="cell-sub">{t.description}</div>}{t.status === "PDNG" && <span className="badge neutral">In attesa</span>}</td>
                        <td className="hide-sm cell-sub">{t.accountName ?? t.accountId}</td>
                        <td className={`right num ${t.amount > 0 ? "pos" : ""}`}>{t.amount > 0 ? "+" : ""}{money(t.amount, t.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
      {picker && <BankPicker busy={busy} onClose={() => setPicker(false)} onPick={(b) => start({ bankName: b.name, country: b.country }, "pick")} />}
    </div>
  );
}

const COUNTRIES: [string, string][] = [["IT", "Italia"], ["LT", "Lituania (Revolut)"], ["FR", "Francia"], ["DE", "Germania"], ["ES", "Spagna"], ["NL", "Paesi Bassi"], ["BE", "Belgio"], ["AT", "Austria"], ["IE", "Irlanda"]];

function BankPicker({ onClose, onPick, busy }: { onClose: () => void; onPick: (b: BankOption) => void; busy: string | null }) {
  const [country, setCountry] = useState("IT");
  const [banks, setBanks] = useState<BankOption[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    setBanks(null); setErr(null);
    listBanks(country).then(setBanks, (e: Error) => setErr(e.message));
  }, [country]);
  const shown = (banks ?? []).filter((b) => b.name.toLowerCase().includes(q.toLowerCase())).slice(0, 80);
  return (
    <Modal title="Collega una banca" onClose={onClose}>
      <div className="form">
        <label className="field"><span>Paese della banca</span>
          <select value={country} onChange={(e) => setCountry(e.target.value)}>{COUNTRIES.map(([c, l]) => <option key={c} value={c}>{l}</option>)}</select>
        </label>
        <label className="field"><span>Cerca</span><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Es. Fineco" autoFocus /></label>
        <div className="wide">
          <ErrorBanner message={err} />
          {!banks && !err && <p className="hint">Carico l'elenco delle banche…</p>}
          {banks && (
            <ul className="list bank-list">
              {shown.map((b) => (
                <li key={b.name}>
                  <button className="row-link bank-pick" disabled={!!busy} onClick={() => onPick(b)}>
                    {b.logo ? <img src={b.logo} alt="" className="bank-logo" /> : <span className="row-icon"><Landmark size={16} aria-hidden /></span>}
                    <span className="row-main"><span className="row-title">{b.name}</span>
                      {b.maxConsentDays && <span className="row-sub">Consenso fino a {b.maxConsentDays} giorni</span>}</span>
                  </button>
                </li>
              ))}
              {shown.length === 0 && <li className="hint">Nessuna banca trovata</li>}
            </ul>
          )}
        </div>
        <p className="hint wide">Verrai portato sul sito della banca per autorizzare la sola lettura di saldi e movimenti, poi tornerai qui.</p>
      </div>
    </Modal>
  );
}
