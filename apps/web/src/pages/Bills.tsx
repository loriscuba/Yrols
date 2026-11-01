import { useState } from "react";
import { Check, Pencil, Plus, ReceiptText, Trash2, Undo2 } from "lucide-react";
import { useData } from "../hooks";
import { api, type Bill, type Meta } from "../api";
import { date, label, money, todayIso } from "../format";
import { Card, DueBadge, Empty, ErrorBanner, Field, Modal, Segmented, Stat } from "../components/ui";

type Filter = "open" | "paid" | "all";

export function BillsPage() {
  const { data, error, reload } = useData<Bill[]>("/bills");
  const meta = useData<Meta>("/meta");
  const [filter, setFilter] = useState<Filter>("open");
  const [editing, setEditing] = useState<Partial<Bill> | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const list = (data ?? []).filter((b) => (filter === "all" ? true : filter === "open" ? !b.paidAt : !!b.paidAt));
  const open = (data ?? []).filter((b) => !b.paidAt);
  const overdue = open.filter((b) => b.dueDate < todayIso());
  const year = new Date().getFullYear().toString();
  const yearTotal = (data ?? []).filter((b) => b.dueDate.startsWith(year)).reduce((s, b) => s + b.amount, 0);

  const act = (p: Promise<unknown>) => p.then(() => { setErr(null); reload(); }, (e: Error) => setErr(e.message));

  return (
    <div className="page">
      <header className="page-head">
        <div><h1>Bollette</h1><p className="sub">Luce, gas, acqua, internet e tutte le utenze di casa</p></div>
        <button className="btn primary" onClick={() => setEditing({ kind: "luce", dueDate: todayIso() })}><Plus size={16} />Nuova bolletta</button>
      </header>
      <ErrorBanner message={error ?? err} />
      <div className="stats">
        <Stat label="Da pagare" value={money(open.reduce((s, b) => s + b.amount, 0))} hint={`${open.length} bollette`} />
        <Stat label="Scadute" value={String(overdue.length)} tone={overdue.length ? "critical" : undefined} hint={overdue.length ? money(overdue.reduce((s, b) => s + b.amount, 0)) : "Tutto in regola"} />
        <Stat label={`Totale ${year}`} value={money(yearTotal)} />
      </div>
      <Card title={<Segmented value={filter} onChange={setFilter} options={[["open", "Da pagare"], ["paid", "Pagate"], ["all", "Tutte"]]} />}>
        {list.length === 0 ? <Empty icon={<ReceiptText />} title={filter === "open" ? "Nessuna bolletta da pagare" : "Nessuna bolletta"} /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Fornitore</th><th className="hide-sm">Tipo</th><th>Scadenza</th><th className="right">Importo</th><th>Stato</th><th /></tr></thead>
              <tbody>
                {list.map((b) => (
                  <tr key={b.id}>
                    <td><div className="cell-title">{b.provider}</div>{b.periodFrom && <div className="cell-sub">{date(b.periodFrom)} – {date(b.periodTo)}</div>}</td>
                    <td className="hide-sm">{label(b.kind)}</td>
                    <td className="nowrap">{date(b.dueDate)}</td>
                    <td className="right num">{money(b.amount)}</td>
                    <td>{b.paidAt ? <DueBadge date={b.paidAt} done /> : <DueBadge date={b.dueDate} />}</td>
                    <td className="actions">
                      {b.paidAt
                        ? <button className="icon-btn" title="Segna da pagare" aria-label="Segna da pagare" onClick={() => act(api.patch(`/bills/${b.id}`, { paidAt: null }))}><Undo2 size={16} /></button>
                        : <button className="icon-btn" title="Segna pagata" aria-label="Segna pagata" onClick={() => act(api.patch(`/bills/${b.id}`, { paidAt: todayIso() }))}><Check size={16} /></button>}
                      <button className="icon-btn" title="Modifica" aria-label="Modifica" onClick={() => setEditing(b)}><Pencil size={16} /></button>
                      <button className="icon-btn" title="Elimina" aria-label="Elimina" onClick={() => confirm(`Eliminare la bolletta ${b.provider}?`) && act(api.del(`/bills/${b.id}`))}><Trash2 size={16} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing && (
        <BillForm bill={editing} kinds={meta.data?.billKinds ?? []} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />
      )}
    </div>
  );
}

function BillForm({ bill, kinds, onClose, onSaved }: { bill: Partial<Bill>; kinds: string[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ ...bill, amount: bill.amount?.toFixed(2).replace(".", ",") ?? "" });
  const [err, setErr] = useState<string | null>(null);
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const body = { provider: f.provider, kind: f.kind, amount: f.amount, dueDate: f.dueDate, periodFrom: f.periodFrom ?? "", periodTo: f.periodTo ?? "", paidAt: f.paidAt ?? "", notes: f.notes ?? "" };
    (bill.id ? api.patch(`/bills/${bill.id}`, body) : api.post("/bills", body)).then(onSaved, (e: Error) => setErr(e.message));
  };
  return (
    <Modal title={bill.id ? "Modifica bolletta" : "Nuova bolletta"} onClose={onClose}>
      <form onSubmit={save} className="form">
        <ErrorBanner message={err} />
        <Field label="Fornitore"><input required value={f.provider ?? ""} onChange={set("provider")} placeholder="Es. Enel Energia" autoFocus /></Field>
        <Field label="Tipo"><select value={f.kind} onChange={set("kind")}>{kinds.map((k) => <option key={k} value={k}>{label(k)}</option>)}</select></Field>
        <Field label="Importo (€)"><input required inputMode="decimal" value={f.amount} onChange={set("amount")} placeholder="0,00" /></Field>
        <Field label="Scadenza"><input required type="date" value={f.dueDate ?? ""} onChange={set("dueDate")} /></Field>
        <Field label="Periodo dal"><input type="date" value={f.periodFrom ?? ""} onChange={set("periodFrom")} /></Field>
        <Field label="al"><input type="date" value={f.periodTo ?? ""} onChange={set("periodTo")} /></Field>
        <Field label="Pagata il"><input type="date" value={f.paidAt ?? ""} onChange={set("paidAt")} /></Field>
        <Field label="Note" wide><textarea rows={2} value={f.notes ?? ""} onChange={set("notes")} /></Field>
        <div className="form-actions"><button type="button" className="btn" onClick={onClose}>Annulla</button><button className="btn primary">Salva</button></div>
      </form>
    </Modal>
  );
}
