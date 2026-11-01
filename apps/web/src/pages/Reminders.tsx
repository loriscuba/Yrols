import { useState } from "react";
import { Bell, Check, Trash2, Undo2 } from "lucide-react";
import { useData } from "../hooks";
import { api, type Reminder } from "../api";
import { dateTime, label } from "../format";
import { Card, Empty, ErrorBanner } from "../components/ui";

export function RemindersPage() {
  const { data, error, reload } = useData<Reminder[]>("/reminders");
  const [text, setText] = useState("");
  const [when, setWhen] = useState("");
  const [priority, setPriority] = useState("normale");
  const [err, setErr] = useState<string | null>(null);
  const act = (p: Promise<unknown>) => p.then(() => { setErr(null); reload(); }, (e: Error) => setErr(e.message));

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    act(api.post("/reminders", { text, priority, remindAt: when ? new Date(when).toISOString() : "" }).then(() => { setText(""); setWhen(""); setPriority("normale"); }));
  };
  const open = (data ?? []).filter((r) => !r.doneAt);
  const done = (data ?? []).filter((r) => r.doneAt);
  const late = (r: Reminder) => r.remindAt && new Date(r.remindAt) < new Date();

  const item = (r: Reminder) => (
    <li key={r.id} className={`row ${r.doneAt ? "muted" : ""}`}>
      <button className={`check ${r.doneAt ? "on" : ""}`} aria-label={r.doneAt ? "Riapri" : "Fatto"} title={r.doneAt ? "Riapri" : "Fatto"}
        onClick={() => act(api.patch(`/reminders/${r.id}`, { doneAt: r.doneAt ? null : new Date().toISOString() }))}>
        {r.doneAt ? <Undo2 size={14} /> : <Check size={14} />}
      </button>
      <span className={`prio prio-${r.priority}`} title={`Priorità ${label(r.priority)}`} aria-label={`Priorità ${label(r.priority)}`} />
      <span className="row-main">
        <span className="row-title">{r.text}</span>
        {r.remindAt && <span className={`row-sub ${late(r) && !r.doneAt ? "tone-critical" : ""}`}>{dateTime(r.remindAt)}</span>}
      </span>
      <button className="icon-btn" aria-label="Elimina" title="Elimina" onClick={() => act(api.del(`/reminders/${r.id}`))}><Trash2 size={16} /></button>
    </li>
  );

  return (
    <div className="page">
      <header className="page-head"><div><h1>Promemoria</h1><p className="sub">Le piccole cose da non dimenticare</p></div></header>
      <ErrorBanner message={error ?? err} />
      <Card>
        <form className="quick-add" onSubmit={add}>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Cosa devi ricordare?" aria-label="Nuovo promemoria" />
          <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} aria-label="Quando" />
          <select value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="Priorità">
            <option value="bassa">Bassa</option><option value="normale">Normale</option><option value="alta">Alta</option>
          </select>
          <button className="btn primary" disabled={!text.trim()}>Aggiungi</button>
        </form>
      </Card>
      <Card title={`Da fare (${open.length})`}>
        {open.length === 0 ? <Empty icon={<Bell />} title="Tutto fatto" /> : <ul className="list">{open.map(item)}</ul>}
      </Card>
      {done.length > 0 && <Card title={`Fatti (${done.length})`}><ul className="list">{done.slice(0, 20).map(item)}</ul></Card>}
    </div>
  );
}
