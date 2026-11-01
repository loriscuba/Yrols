import { useMemo, useState } from "react";
import { KeyRound, Landmark, Search } from "lucide-react";
import { useData } from "../hooks";
import type { Account, Connection, Transaction } from "../api";
import { date, money, dateTime } from "../format";
import { Card, DueBadge, Empty, ErrorBanner, Stat } from "../components/ui";

export function BanksPage() {
  const accounts = useData<Account[]>("/banks/accounts");
  const connections = useData<Connection[]>("/banks/connections");
  const lastSync = useData<{ receivedAt: string; source: string } | null>("/banks/last-sync");
  const [accountId, setAccountId] = useState("");
  const [q, setQ] = useState("");
  const params = new URLSearchParams({ limit: "300", ...(accountId && { accountId }), ...(q.length > 1 && { q }) });
  const txs = useData<Transaction[]>(`/banks/transactions?${params}`);
  const total = useMemo(() => (accounts.data ?? []).reduce((s, a) => s + (a.balance ?? 0), 0), [accounts.data]);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Banche</h1>
          <p className="sub">{lastSync.data ? `Ultimo aggiornamento ${dateTime(lastSync.data.receivedAt)}` : "Dati dal connettore Enable Banking"}</p>
        </div>
      </header>
      <ErrorBanner message={accounts.error ?? txs.error} />
      {accounts.data && accounts.data.length === 0 ? (
        <Card>
          <Empty icon={<Landmark />} title="Nessun conto collegato">
            Avvia il connettore Enable Banking e impostagli l'indirizzo di questo cruscotto e il token <code>YROLS_INGEST_TOKEN</code>: i conti compariranno qui alla prima sincronizzazione.
          </Empty>
        </Card>
      ) : (
        <>
          <div className="stats">
            <Stat label="Totale sui conti" value={money(total)} />
            {accounts.data?.map((a) => (
              <button key={a.id} className={`stat stat-btn ${accountId === a.id ? "on" : ""}`} onClick={() => setAccountId(accountId === a.id ? "" : a.id)}>
                <div className="stat-label">{a.bankName ?? "Banca"} · {a.name ?? a.iban ?? a.id}</div>
                <div className="stat-value">{money(a.balance, a.currency)}</div>
                <div className="stat-hint">{a.iban ? `…${a.iban.slice(-4)}` : ""}{a.balanceDate ? ` · saldo al ${date(a.balanceDate)}` : ""}</div>
              </button>
            ))}
          </div>

          {connections.data && connections.data.some((c) => c.validUntil) && (
            <Card title="Consensi bancari (PSD2)">
              <ul className="list">
                {connections.data.filter((c) => c.validUntil).map((c) => (
                  <li key={c.id} className="row">
                    <span className="row-icon"><KeyRound size={16} aria-hidden /></span>
                    <span className="row-main"><span className="row-title">{c.bankName ?? c.id}</span><span className="row-sub">Valido fino al {date(c.validUntil)}: va rinnovato dal connettore</span></span>
                    <DueBadge date={c.validUntil!} />
                  </li>
                ))}
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
    </div>
  );
}
