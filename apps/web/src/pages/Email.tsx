import { useState } from "react";
import { CalendarClock, Check, Mail, ReceiptText, RefreshCw, X } from "lucide-react";
import { useData } from "../hooks";
import { api, type Suggestion } from "../api";
import { date, dateTime, label } from "../format";
import { Card, Empty, ErrorBanner } from "../components/ui";

interface Status { configured: boolean; cloud?: boolean; user: string | null; host: string | null; lastScan: { at: string; summary: string } | null }

export function EmailPage() {
  const status = useData<Status>("/email/status");
  const { data, error, reload } = useData<Suggestion[]>("/email/suggestions");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const scan = () => {
    setBusy(true); setMsg(null); setErr(null);
    api.post<{ scanned: number; found: number }>("/email/scan").then(
      (r) => { setMsg(`Lette ${r.scanned} email, ${r.found} nuove da confermare.`); reload(); status.reload(); },
      (e: Error) => setErr(e.message),
    ).finally(() => setBusy(false));
  };
  const last = status.data?.lastScan;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Da email</h1>
          <p className="sub">{status.data?.cloud
            ? (last ? `Letta in automatico ogni ora · ultima lettura ${dateTime(last.at)}` : "Bollette e scadenze trovate nella posta")
            : status.data?.configured ? `Casella ${status.data.user}${last ? ` · ultima lettura ${dateTime(last.at)}` : ""}` : "Bollette e scadenze trovate nella posta"}</p>
        </div>
        {status.data?.configured && !status.data.cloud && <button className="btn primary" onClick={scan} disabled={busy}><RefreshCw size={16} className={busy ? "spin" : ""} />{busy ? "Lettura in corso…" : "Controlla la posta"}</button>}
      </header>
      <ErrorBanner message={error ?? err} />
      {msg && <div className="banner info">{msg}</div>}
      {status.data && !status.data.configured && (
        <Card title="Collega la tua casella">
          <div className="prose">
            <p>Il cruscotto legge la posta via IMAP, riconosce bollette e scadenze (fornitore, importo, data) e te le propone qui: niente viene aggiunto senza la tua conferma.</p>
            {status.data.cloud ? (
              <p>Su GitHub, in <em>Settings → Secrets and variables → Actions</em>, aggiungi i secret <code>YROLS_IMAP_HOST</code> (es. <code>imap.gmail.com</code>), <code>YROLS_IMAP_USER</code> e <code>YROLS_IMAP_PASSWORD</code>. La posta verrà letta ogni ora.</p>
            ) : (<>
            <p>Imposta nel file <code>.env</code> del server:</p>
            <pre>{`YROLS_IMAP_HOST=imap.gmail.com
YROLS_IMAP_USER=tuo.indirizzo@gmail.com
YROLS_IMAP_PASSWORD=password-per-le-app
YROLS_IMAP_INTERVAL_MIN=60`}</pre></>)}
            <p>Con Gmail serve una <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">password per le app</a> (richiede la verifica in due passaggi). Per altri provider usa il loro server IMAP, ad esempio <code>imap.libero.it</code>, <code>imap.mail.yahoo.com</code>, <code>outlook.office365.com</code>.</p>
          </div>
        </Card>
      )}
      <Card title="Da confermare">
        {data?.length === 0 ? <Empty icon={<Mail />} title="Nessuna proposta in attesa" /> : (
          <ul className="list">{data?.map((s) => <SuggestionRow key={s.id} s={s} onDone={reload} />)}</ul>
        )}
      </Card>
    </div>
  );
}

function SuggestionRow({ s, onDone }: { s: Suggestion; onDone: () => void }) {
  const [amount, setAmount] = useState(s.amount?.toFixed(2).replace(".", ",") ?? "");
  const [dueDate, setDueDate] = useState(s.dueDate ?? "");
  const [name, setName] = useState((s.kind === "bill" ? s.provider : s.title) ?? "");
  const [err, setErr] = useState<string | null>(null);
  const Icon = s.kind === "bill" ? ReceiptText : CalendarClock;
  const accept = () => api.post(`/email/suggestions/${s.id}/accept`, { amount, dueDate, ...(s.kind === "bill" ? { provider: name } : { title: name }) })
    .then(onDone, (e: Error) => setErr(e.message));
  return (
    <li className="suggestion">
      <div className="row">
        <span className="row-icon"><Icon size={16} aria-hidden /></span>
        <span className="row-main">
          <span className="row-title">{s.subject}</span>
          <span className="row-sub">{s.sender} · {date(s.receivedAt)} · {s.kind === "bill" ? `Bolletta ${label(s.billKind)}` : "Scadenza"}</span>
        </span>
      </div>
      {s.snippet && <p className="snippet">{s.snippet}</p>}
      <div className="suggestion-form">
        <input value={name} onChange={(e) => setName(e.target.value)} aria-label={s.kind === "bill" ? "Fornitore" : "Titolo"} placeholder={s.kind === "bill" ? "Fornitore" : "Titolo"} />
        <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" aria-label="Importo" placeholder="Importo €" />
        <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} aria-label="Scadenza" />
        <button className="btn primary" onClick={accept}><Check size={16} />Aggiungi</button>
        <button className="btn" onClick={() => api.post(`/email/suggestions/${s.id}/dismiss`).then(onDone)}><X size={16} />Ignora</button>
      </div>
      <ErrorBanner message={err} />
    </li>
  );
}
