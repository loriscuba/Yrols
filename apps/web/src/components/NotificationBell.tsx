import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, BellOff, BellRing, Landmark, PiggyBank, Share, SquarePlus, TrendingUp, X } from "lucide-react";
import {
  disablePush, enablePush, KINDS, loadNotices, markAllRead, pushStatus, setPushKinds, testPush, unreadCount,
  type Notice, type NoticeKind, type PushState,
} from "../notifications";
import { DATA_CHANGED } from "../bankRefresh";
import { whenAt } from "../format";

const ICON: Record<NoticeKind, typeof Bell> = { movimento: Landmark, portafoglio: TrendingUp, offerta: PiggyBank };
const POLL_MS = 60_000;

/** Campanella in alto a destra: conteggio delle novità non lette, elenco e attivazione delle notifiche sul dispositivo. */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(0);
  const refresh = useCallback(() => { unreadCount().then(setCount, () => { /* resta il valore precedente */ }); }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, POLL_MS);
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    addEventListener(DATA_CHANGED, refresh);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVisible); removeEventListener(DATA_CHANGED, refresh); };
  }, [refresh]);

  return (
    <>
      <button className={`bell-btn ${open ? "active" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="novita"
        aria-label={count ? `Notifiche: ${count} da leggere` : "Notifiche"}>
        <Bell size={20} aria-hidden />
        {count > 0 && <span className="bell-count" aria-hidden>{count > 99 ? "99+" : count}</span>}
      </button>
      {open && <Panel onClose={() => { setOpen(false); refresh(); }} onRead={() => setCount(0)} />}
    </>
  );
}

function Panel({ onClose, onRead }: { onClose: () => void; onRead: () => void }) {
  const navigate = useNavigate();
  const [items, setItems] = useState<Notice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadNotices().then((n) => {
      setItems(n);
      if (n.some((x) => !x.readAt)) markAllRead().then(onRead, () => { /* riprova alla prossima apertura */ });
    }, (e: Error) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const outside = (e: PointerEvent) => {
      const t = e.target as Element;
      if (ref.current && !ref.current.contains(t) && !t.closest(".bell-btn")) onClose();
    };
    addEventListener("keydown", esc);
    addEventListener("pointerdown", outside);
    return () => { removeEventListener("keydown", esc); removeEventListener("pointerdown", outside); };
  }, [onClose]);

  const go = (n: Notice) => { onClose(); navigate(n.url || "/"); };

  return (
    <div className="bell-panel" id="novita" role="dialog" aria-label="Novità" ref={ref}>
      <div className="bell-head">
        <h2>Novità</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Chiudi"><X size={18} /></button>
      </div>
      <div className="bell-list">
        {error && <p className="hint bell-empty">{error}</p>}
        {!error && items === null && <p className="hint bell-empty">Carico…</p>}
        {items?.length === 0 && (
          <p className="hint bell-empty">Ancora nessuna novità. Qui compariranno i nuovi movimenti, gli aggiornamenti dei portafogli e le offerte del Risparmio.</p>
        )}
        {items?.map((n) => {
          const Icon = ICON[n.kind] ?? Bell;
          return (
            <button key={n.id} className={`bell-item ${n.readAt ? "" : "unread"}`} onClick={() => go(n)}>
              <span className={`bell-icon k-${n.kind}`} aria-hidden><Icon size={16} /></span>
              <span className="bell-text">
                <span className="bell-title">{n.title}</span>
                {n.body && <span className="bell-body">{n.body}</span>}
                <span className="bell-when">{whenAt(n.createdAt)}</span>
              </span>
            </button>
          );
        })}
      </div>
      <PushSettings />
    </div>
  );
}

function PushSettings() {
  const [s, setS] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => { pushStatus().then(setS, () => setS({ state: "unsupported" })); }, []);

  const run = async (f: () => Promise<PushState | void>, done?: string) => {
    setBusy(true); setMsg(null);
    try { const r = await f(); if (r) setS(r); if (done) setMsg(done); }
    catch (e) { setMsg((e as Error).message); }
    finally { setBusy(false); }
  };

  if (!s) return null;
  return (
    <div className="bell-push">
      <div className="bell-push-head">
        {s.state === "on" ? <BellRing size={16} aria-hidden /> : <BellOff size={16} aria-hidden />}
        <strong>Notifiche su questo dispositivo</strong>
      </div>

      {s.state === "ios-home" && (
        <>
          <p className="hint">Su iPhone le notifiche arrivano solo se Yrols è sulla schermata Home. Una volta sola:</p>
          <ol className="steps">
            <li>In Safari tocca <Share size={14} aria-label="Condividi" /> <b>Condividi</b>.</li>
            <li>Scegli <SquarePlus size={14} aria-hidden /> <b>Aggiungi alla schermata Home</b>, poi <b>Aggiungi</b>.</li>
            <li>Apri Yrols dalla nuova icona, entra e torna qui sulla campanella: troverai il pulsante per attivarle.</li>
          </ol>
        </>
      )}
      {s.state === "unsupported" && <p className="hint">Questo browser non riceve notifiche push. Sul cellulare usa Chrome (Android) o l'icona sulla schermata Home (iPhone).</p>}
      {s.state === "denied" && (
        <p className="hint">Le notifiche per Yrols sono bloccate. Riattivale dalle impostazioni: su iPhone Impostazioni › Notifiche › Yrols; su Android tieni premuta l'icona › Info app › Notifiche.</p>
      )}
      {s.state === "off" && (
        <>
          <p className="hint">Ricevi un avviso per nuovi movimenti, portafogli aggiornati e nuove offerte, anche ad app chiusa.</p>
          <button className="btn primary" disabled={busy} onClick={() => run(enablePush, "Notifiche attive su questo dispositivo.")}>
            <BellRing size={16} aria-hidden /> Attiva le notifiche
          </button>
        </>
      )}
      {s.state === "on" && (
        <>
          <div className="bell-kinds" role="group" aria-label="Cosa notificare">
            {KINDS.map(([k, label]) => {
              const on = s.kinds.includes(k);
              return (
                <label key={k} className="bell-kind">
                  <input type="checkbox" checked={on} disabled={busy} onChange={() => {
                    const kinds = on ? s.kinds.filter((x) => x !== k) : [...s.kinds, k];
                    run(async () => { await setPushKinds(kinds); return { state: "on", kinds }; });
                  }} />
                  {label}
                </label>
              );
            })}
          </div>
          <div className="bell-actions">
            <button className="btn" disabled={busy} onClick={() => run(async () => {
              const n = await testPush();
              setMsg(n ? "Notifica di prova inviata." : "Nessun dispositivo ha ricevuto la prova: riattiva le notifiche.");
            })}>Invia una prova</button>
            <button className="btn" disabled={busy} onClick={() => run(disablePush, "Notifiche disattivate su questo dispositivo.")}>Disattiva</button>
          </div>
        </>
      )}
      {msg && <p className="hint" role="status">{msg}</p>}
    </div>
  );
}
