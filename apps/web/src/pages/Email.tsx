import { useEffect, useRef, useState } from "react";
import { CalendarClock, Check, Link2Off, Mail, ReceiptText, RefreshCw, ShieldCheck, X } from "lucide-react";
import { useData } from "../hooks";
import { api, type Suggestion } from "../api";
import { date, dateTime, label } from "../format";
import { Card, Empty, ErrorBanner } from "../components/ui";
import { completeGmailAuth, disconnectGmail, startGmailAuth } from "../emailAuth";

interface Status {
  configured: boolean; cloud?: boolean; user: string | null; host: string | null; lastScan: { at: string; summary: string } | null;
  provider?: string | null; accountStatus?: "active" | "expired" | null;
}

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
  const cloud = !!status.data?.cloud;
  const gmail = cloud && status.data?.provider === "gmail" ? status.data : null;

  const connectGmail = () => {
    setBusy(true); setMsg(null); setErr(null);
    startGmailAuth(gmail?.user ?? undefined).catch((e: Error) => { setBusy(false); setErr(e.message); });
  };
  const disconnect = () => {
    if (!confirm("Scollegare Gmail? Il permesso di lettura viene revocato anche su Google. Le proposte già trovate restano.")) return;
    setBusy(true); setMsg(null); setErr(null);
    disconnectGmail().then(() => { setMsg("Gmail scollegata e permesso revocato."); status.reload(); }, (e: Error) => setErr(e.message)).finally(() => setBusy(false));
  };

  // Ritorno da Google: /email?gm_state=…&gm_code=… (oppure gm_error). Si completa una sola volta.
  const handled = useRef(false);
  useEffect(() => {
    if (handled.current) return;
    const qs = new URLSearchParams(location.search);
    const state = qs.get("gm_state");
    if (!state) return;
    handled.current = true;
    history.replaceState(null, "", location.pathname);
    setBusy(true);
    completeGmailAuth({ state, code: qs.get("gm_code") ?? undefined, error: qs.get("gm_error") ?? undefined }).then((r) => {
      if (r.email) setMsg(`Gmail collegata (${r.email}) in sola lettura. La posta verrà letta entro un'ora.`);
      else setErr(r.error === "access_denied" ? "Collegamento annullato su Google."
        : r.error === "scope_missing" ? "Serve la spunta \"Leggere i messaggi\" nella pagina di Google: riprova e lasciala attiva."
        : `Collegamento Gmail non riuscito (${r.error}).`);
      status.reload();
    }, (e: Error) => setErr(e.message)).finally(() => setBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Da email</h1>
          <p className="sub">{cloud
            ? (last ? `Letta in automatico ogni ora · ultima lettura ${dateTime(last.at)}` : "Bollette e scadenze trovate nella posta")
            : status.data?.configured ? `Casella ${status.data.user}${last ? ` · ultima lettura ${dateTime(last.at)}` : ""}` : "Bollette e scadenze trovate nella posta"}</p>
        </div>
        {status.data?.configured && !status.data.cloud && <button className="btn primary" onClick={scan} disabled={busy}><RefreshCw size={16} className={busy ? "spin" : ""} />{busy ? "Lettura in corso…" : "Controlla la posta"}</button>}
      </header>
      <ErrorBanner message={error ?? err} />
      {msg && <div className="banner info">{msg}</div>}
      {gmail && (
        <Card title="Casella collegata" action={<button className="btn" onClick={disconnect} disabled={busy}><Link2Off size={16} />Scollega</button>}>
          <div className="row">
            <span className="row-icon"><ShieldCheck size={16} aria-hidden /></span>
            <span className="row-main">
              <span className="row-title">Gmail · {gmail.user}</span>
              <span className="row-sub">Accesso Google in sola lettura, revocabile in ogni momento{last ? ` · ultima lettura ${dateTime(last.at)}` : " · prima lettura entro un'ora"}</span>
            </span>
          </div>
          {gmail.accountStatus === "expired" && (
            <div className="banner critical">L'accesso a Gmail è scaduto o è stato revocato. <button className="btn primary" onClick={connectGmail} disabled={busy}>Ricollega Gmail</button></div>
          )}
        </Card>
      )}
      {status.data && !status.data.configured && (
        <Card title="Collega la tua casella">
          <div className="prose">
            <p>Il cruscotto legge la posta, riconosce bollette e scadenze (fornitore, importo, data) e te le propone qui: niente viene aggiunto senza la tua conferma.</p>
            {cloud ? (<>
              <p>Con Gmail il collegamento usa l'accesso Google <strong>in sola lettura</strong>: Yrols non vede la tua password, non può inviare né cancellare email, e puoi revocarlo quando vuoi da qui o da <a href="https://myaccount.google.com/connections" target="_blank" rel="noreferrer">myaccount.google.com</a>.</p>
              <p><button className="btn primary" onClick={connectGmail} disabled={busy}><Mail size={16} />{busy ? "Apertura di Google…" : "Collega Gmail"}</button></p>
              <p className="sub">Altri provider (Outlook, Libero, Aruba…): su GitHub, in <em>Settings → Secrets and variables → Actions</em>, aggiungi <code>YROLS_IMAP_HOST</code>, <code>YROLS_IMAP_USER</code> e <code>YROLS_IMAP_PASSWORD</code> (una password per le app, non quella principale).</p>
            </>) : (<>
            <p>Imposta nel file <code>.env</code> del server:</p>
            <pre>{`YROLS_IMAP_HOST=imap.gmail.com
YROLS_IMAP_USER=tuo.indirizzo@gmail.com
YROLS_IMAP_PASSWORD=password-per-le-app
YROLS_IMAP_INTERVAL_MIN=60`}</pre>
            <p>Con Gmail serve una <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">password per le app</a> (richiede la verifica in due passaggi). Per altri provider usa il loro server IMAP, ad esempio <code>imap.libero.it</code>, <code>imap.mail.yahoo.com</code>, <code>outlook.office365.com</code>.</p></>)}
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
          <span className="row-sub">{s.sender} · {date(s.receivedAt)} · {s.kind === "bill" ? `Bolletta ${label(s.billKind)}` : "Scadenza"}{s.invoiceNumber ? ` · fattura ${s.invoiceNumber}` : ""}{s.filePath ? " · PDF allegato" : ""}</span>
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
