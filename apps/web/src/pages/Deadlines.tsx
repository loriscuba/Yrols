import { useState } from "react";
import { CalendarClock, Check, Pencil, Plus, Repeat, Trash2, Undo2 } from "lucide-react";
import { useData } from "../hooks";
import { api, type Deadline, type Meta } from "../api";
import { date, label, money, todayIso } from "../format";
import { Card, DueBadge, Empty, ErrorBanner, Field, Modal, Segmented } from "../components/ui";

type Filter = "open" | "done";

export function DeadlinesPage() {
  const { data, error, reload } = useData<Deadline[]>("/deadlines");
  const meta = useData<Meta>("/meta");
  const [filter, setFilter] = useState<Filter>("open");
  const [cat, setCat] = useState("");
  const [editing, setEditing] = useState<Partial<Deadline> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const act = (p: Promise<unknown>) => p.then(() => { setErr(null); reload(); }, (e: Error) => setErr(e.message));

  const list = (data ?? []).filter((d) => (filter === "open" ? !d.doneAt : !!d.doneAt) && (!cat || d.category === cat));
  // Raggruppa per mese
  const groups = new Map<string, Deadline[]>();
  for (const d of list) {
    const k = d.dueDate < todayIso() && !d.doneAt ? "Scadute" : date(d.dueDate, { month: "long", year: "numeric" });
    groups.set(k, [...(groups.get(k) ?? []), d]);
  }

  return (
    <div className="page">
      <header className="page-head">
        <div><h1>Scadenze</h1><p className="sub">Tasse, auto, assicurazioni, documenti e rinnovi</p></div>
        <button className="btn primary" onClick={() => setEditing({ category: "casa", recurrence: "none", dueDate: todayIso() })}><Plus size={16} />Nuova scadenza</button>
      </header>
      <ErrorBanner message={error ?? err} />
      <div className="toolbar">
        <Segmented value={filter} onChange={setFilter} options={[["open", "Da fare"], ["done", "Completate"]]} />
        <select value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Categoria">
          <option value="">Tutte le categorie</option>
          {meta.data?.deadlineCategories.map((c) => <option key={c} value={c}>{label(c)}</option>)}
        </select>
      </div>
      {list.length === 0 ? <Card><Empty icon={<CalendarClock />} title={filter === "open" ? "Nessuna scadenza in programma" : "Nessuna scadenza completata"} /></Card> :
        [...groups].map(([g, items]) => (
          <Card key={g} title={<span className={g === "Scadute" ? "tone-critical" : ""} style={{ textTransform: "capitalize" }}>{g}</span>}>
            <ul className="list">
              {items.map((d) => (
                <li key={d.id} className="row wrap-sm">
                  <button className={`check ${d.doneAt ? "on" : ""}`} aria-label={d.doneAt ? "Riapri" : "Segna completata"} title={d.doneAt ? "Riapri" : "Segna completata"}
                    onClick={() => act(api.patch(`/deadlines/${d.id}`, { doneAt: d.doneAt ? null : todayIso() }))}>
                    {d.doneAt ? <Undo2 size={14} /> : <Check size={14} />}
                  </button>
                  <span className="row-main">
                    <span className="row-title">{d.title}</span>
                    <span className="row-sub">{label(d.category)} · {date(d.dueDate)}{d.recurrence !== "none" && <> · <Repeat size={12} aria-hidden /> {label(d.recurrence)}</>}{d.notes && ` · ${d.notes}`}</span>
                  </span>
                  <span className="row-end">
                    {d.amount !== null && <span className="num">{money(d.amount)}</span>}
                    <DueBadge date={d.dueDate} done={!!d.doneAt} />
                  </span>
                  <span className="actions">
                    <button className="icon-btn" aria-label="Modifica" title="Modifica" onClick={() => setEditing(d)}><Pencil size={16} /></button>
                    <button className="icon-btn" aria-label="Elimina" title="Elimina" onClick={() => confirm(`Eliminare "${d.title}"?`) && act(api.del(`/deadlines/${d.id}`))}><Trash2 size={16} /></button>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        ))}
      {editing && meta.data && <DeadlineForm item={editing} meta={meta.data} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    </div>
  );
}

function DeadlineForm({ item, meta, onClose, onSaved }: { item: Partial<Deadline>; meta: Meta; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ ...item, amount: item.amount?.toFixed(2).replace(".", ",") ?? "" });
  const [err, setErr] = useState<string | null>(null);
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const body = { title: f.title, category: f.category, dueDate: f.dueDate, amount: f.amount, recurrence: f.recurrence, notes: f.notes ?? "" };
    (item.id ? api.patch(`/deadlines/${item.id}`, body) : api.post("/deadlines", body)).then(onSaved, (e: Error) => setErr(e.message));
  };
  return (
    <Modal title={item.id ? "Modifica scadenza" : "Nuova scadenza"} onClose={onClose}>
      <form onSubmit={save} className="form">
        <ErrorBanner message={err} />
        <Field label="Cosa scade" wide><input required value={f.title ?? ""} onChange={set("title")} placeholder="Es. Bollo auto" autoFocus /></Field>
        <Field label="Categoria"><select value={f.category} onChange={set("category")}>{meta.deadlineCategories.map((c) => <option key={c} value={c}>{label(c)}</option>)}</select></Field>
        <Field label="Data"><input required type="date" value={f.dueDate ?? ""} onChange={set("dueDate")} /></Field>
        <Field label="Importo (€, facoltativo)"><input inputMode="decimal" value={f.amount} onChange={set("amount")} /></Field>
        <Field label="Si ripete"><select value={f.recurrence} onChange={set("recurrence")}>{meta.recurrences.map((r) => <option key={r} value={r}>{label(r)}</option>)}</select></Field>
        <Field label="Note" wide><textarea rows={2} value={f.notes ?? ""} onChange={set("notes")} /></Field>
        <p className="hint wide">Le scadenze ricorrenti, una volta completate, si ripropongono da sole alla data successiva.</p>
        <div className="form-actions"><button type="button" className="btn" onClick={onClose}>Annulla</button><button className="btn primary">Salva</button></div>
      </form>
    </Modal>
  );
}
