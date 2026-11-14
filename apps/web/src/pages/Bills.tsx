import { useRef, useState } from "react";
import { Check, FileText, FileUp, Pencil, Plus, ReceiptText, Trash2, Undo2 } from "lucide-react";
import { useData } from "../hooks";
import { api, type Bill, type Meta } from "../api";
import { cloudEnabled, uploadInvoicePdf } from "../cloud";
import { readInvoicePdf } from "../invoice";
import { date, label, money, todayIso } from "../format";
import { Card, DueBadge, Empty, ErrorBanner, Field, Modal, Segmented, Stat } from "../components/ui";

type Filter = "open" | "paid" | "all";

export function BillsPage() {
  const { data, error, reload } = useData<Bill[]>("/bills");
  const meta = useData<Meta>("/meta");
  const [filter, setFilter] = useState<Filter>("open");
  const [editing, setEditing] = useState<Partial<Bill> | null>(null);
  const [pdf, setPdf] = useState<File | null>(null);
  const [detail, setDetail] = useState<Bill | null>(null);
  const [reading, setReading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const onPdf = async (file: File | undefined) => {
    if (!file) return;
    setReading(true);
    try {
      const inv = await readInvoicePdf(file);
      setPdf(file);
      setEditing({
        provider: inv.provider ?? "", kind: inv.kind ?? "altro", amount: inv.amount ?? undefined, dueDate: inv.dueDate ?? todayIso(),
        periodFrom: inv.periodFrom, periodTo: inv.periodTo, invoiceNumber: inv.invoiceNumber, issueDate: inv.issueDate, items: inv.items.length ? inv.items : null,
      });
      setErr(null);
    } catch {
      setErr("Non riesco a leggere questo PDF (forse è una scansione o è protetto da password): inserisci i dati a mano.");
      setPdf(file);
      setEditing({ kind: "altro", dueDate: todayIso() });
    } finally {
      setReading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };
  const closeForm = () => { setEditing(null); setPdf(null); };

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
        <div className="head-actions">
          <input ref={fileInput} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => onPdf(e.target.files?.[0])} />
          <button className="btn" onClick={() => fileInput.current?.click()} disabled={reading}><FileUp size={16} />{reading ? "Lettura PDF…" : "Carica fattura PDF"}</button>
          <button className="btn primary" onClick={() => setEditing({ kind: "luce", dueDate: todayIso() })}><Plus size={16} />Nuova bolletta</button>
        </div>
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
            <table className="table stack-sm">
              <thead><tr><th>Fornitore</th><th className="hide-sm">Tipo</th><th>Scadenza</th><th className="right">Importo</th><th>Stato</th><th /></tr></thead>
              <tbody>
                {list.map((b) => (
                  <tr key={b.id}>
                    <td className="c-main">
                      <div className="cell-title">{b.invoiceNumber || b.items?.length || b.filePath
                        ? <button className="link-btn" onClick={() => setDetail(b)}>{b.provider}</button> : b.provider}</div>
                      {(b.invoiceNumber || b.periodFrom) && <div className="cell-sub">{[b.invoiceNumber && `Fattura ${b.invoiceNumber}`, b.periodFrom && `${date(b.periodFrom)} – ${date(b.periodTo)}`].filter(Boolean).join(" · ")}</div>}
                    </td>
                    <td className="hide-sm">{label(b.kind)}</td>
                    <td className="nowrap c-date">{date(b.dueDate)}</td>
                    <td className="right num c-amt">{money(b.amount)}</td>
                    <td className="c-state">{b.paidAt ? <DueBadge date={b.paidAt} done /> : <DueBadge date={b.dueDate} />}</td>
                    <td className="actions c-act">
                      {b.paidAt
                        ? <button className="icon-btn" title="Segna da pagare" aria-label="Segna da pagare" onClick={() => act(api.patch(`/bills/${b.id}`, { paidAt: null }))}><Undo2 size={16} /></button>
                        : <button className="icon-btn" title="Segna pagata" aria-label="Segna pagata" onClick={() => act(api.patch(`/bills/${b.id}`, { paidAt: todayIso() }))}><Check size={16} /></button>}
                      {b.filePath && <button className="icon-btn" title="Apri PDF" aria-label="Apri PDF" onClick={() => openPdf(b.filePath!).catch((e: Error) => setErr(e.message))}><FileText size={16} /></button>}
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
        <BillForm bill={editing} pdf={pdf} kinds={meta.data?.billKinds ?? []} onClose={closeForm} onSaved={() => { closeForm(); reload(); }} />
      )}
      {detail && <InvoiceDetail bill={detail} onClose={() => setDetail(null)} onError={setErr} />}
    </div>
  );
}

/** Apre il PDF con un link temporaneo (5 minuti). La finestra si apre subito, così Safari non la blocca. */
async function openPdf(path: string) {
  const win = window.open("about:blank", "_blank");
  try {
    const { url } = await api.get<{ url: string }>(`/bills/file?path=${encodeURIComponent(path)}`);
    if (win) win.location.href = url; else window.location.href = url;
  } catch (e) { win?.close(); throw e; }
}

function InvoiceDetail({ bill: b, onClose, onError }: { bill: Bill; onClose: () => void; onError: (m: string) => void }) {
  return (
    <Modal title={`${b.provider}${b.invoiceNumber ? ` · fattura ${b.invoiceNumber}` : ""}`} onClose={onClose}>
      <dl className="facts">
        <dt>Totale</dt><dd className="num">{money(b.amount)}</dd>
        <dt>Scadenza</dt><dd>{date(b.dueDate)}</dd>
        {b.issueDate && <><dt>Emessa il</dt><dd>{date(b.issueDate)}</dd></>}
        {b.periodFrom && <><dt>Periodo</dt><dd>{date(b.periodFrom)} – {date(b.periodTo)}</dd></>}
        <dt>Stato</dt><dd>{b.paidAt ? `Pagata il ${date(b.paidAt)}` : "Da pagare"}</dd>
        {b.source && b.source !== "manuale" && <><dt>Origine</dt><dd>{b.source === "email" ? "Email" : "PDF caricato"}</dd></>}
      </dl>
      {!!b.items?.length && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Voce</th><th className="right">IVA</th><th className="right">Importo</th></tr></thead>
            <tbody>{b.items.map((i, n) => <tr key={n}><td>{i.description}</td><td className="right">{i.vat !== null ? `${i.vat}%` : ""}</td><td className="right num">{money(i.amount)}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      {b.notes && <p className="hint">{b.notes}</p>}
      <div className="form-actions">
        {b.filePath && <button className="btn" onClick={() => openPdf(b.filePath!).catch((e: Error) => onError(e.message))}><FileText size={16} />Apri PDF</button>}
        <button className="btn primary" onClick={onClose}>Chiudi</button>
      </div>
    </Modal>
  );
}

function BillForm({ bill, pdf, kinds, onClose, onSaved }: { bill: Partial<Bill>; pdf: File | null; kinds: string[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ ...bill, amount: bill.amount?.toFixed(2).replace(".", ",") ?? "" });
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const isInvoice = !!pdf || !!f.invoiceNumber;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = { provider: f.provider, kind: f.kind, amount: f.amount, dueDate: f.dueDate, periodFrom: f.periodFrom ?? "", periodTo: f.periodTo ?? "", paidAt: f.paidAt ?? "", notes: f.notes ?? "" };
    setSaving(true);
    try {
      if (bill.id) await api.patch(`/bills/${bill.id}`, { ...body, invoiceNumber: f.invoiceNumber ?? "", issueDate: f.issueDate ?? "" });
      else if (isInvoice && cloudEnabled) {
        const filePath = pdf ? await uploadInvoicePdf(pdf) : "";
        await api.post("/bills/invoice", { ...body, invoiceNumber: f.invoiceNumber ?? "", issueDate: f.issueDate ?? "", items: f.items ?? null, filePath, source: pdf ? "pdf" : "manuale" });
      } else await api.post("/bills", body);
      onSaved();
    } catch (e) { setErr((e as Error).message); } finally { setSaving(false); }
  };
  return (
    <Modal title={bill.id ? "Modifica bolletta" : pdf ? "Fattura dal PDF" : "Nuova bolletta"} onClose={onClose}>
      <form onSubmit={save} className="form">
        <ErrorBanner message={err} />
        {pdf && !bill.id && <div className="banner info">Dati letti da «{pdf.name}»: controllali e salva.{bill.items?.length ? ` ${bill.items.length} voci di costo.` : ""}</div>}
        <Field label="Fornitore"><input required value={f.provider ?? ""} onChange={set("provider")} placeholder="Es. Enel Energia" autoFocus /></Field>
        <Field label="Tipo"><select value={f.kind} onChange={set("kind")}>{kinds.map((k) => <option key={k} value={k}>{label(k)}</option>)}</select></Field>
        <Field label="Importo (€)"><input required inputMode="decimal" value={f.amount} onChange={set("amount")} placeholder="0,00" /></Field>
        <Field label="Scadenza"><input required type="date" value={f.dueDate ?? ""} onChange={set("dueDate")} /></Field>
        <Field label="Periodo dal"><input type="date" value={f.periodFrom ?? ""} onChange={set("periodFrom")} /></Field>
        <Field label="al"><input type="date" value={f.periodTo ?? ""} onChange={set("periodTo")} /></Field>
        {isInvoice && <Field label="Numero fattura"><input value={f.invoiceNumber ?? ""} onChange={set("invoiceNumber")} /></Field>}
        {isInvoice && <Field label="Emessa il"><input type="date" value={f.issueDate ?? ""} onChange={set("issueDate")} /></Field>}
        <Field label="Pagata il"><input type="date" value={f.paidAt ?? ""} onChange={set("paidAt")} /></Field>
        <Field label="Note" wide><textarea rows={2} value={f.notes ?? ""} onChange={set("notes")} /></Field>
        <div className="form-actions"><button type="button" className="btn" onClick={onClose}>Annulla</button><button className="btn primary" disabled={saving}>{saving ? "Salvataggio…" : "Salva"}</button></div>
      </form>
    </Modal>
  );
}
