import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, CheckCircle2, Clock, Image as ImageIcon, Lightbulb, Link2, Pencil, RefreshCw, ShoppingCart, Store, Trash2, Unlink } from "lucide-react";
import { cloudEnabled } from "../cloud";
import { date, money, todayIso } from "../format";
import { Card, Empty, ErrorBanner, Field, Modal, Stat } from "../components/ui";
import {
  candidates, createReceipt, deleteReceipt, linkTx, listReceipts, photoBlob, photoUrl, readReceipt, savings, shrinkPhoto, updateReceipt,
  type LinkedTx, type Receipt, type ReceiptReading,
} from "../receipts";

const storeName = (r: Pick<Receipt, "store" | "analysis">) => r.analysis?.chain && r.store && !r.store.toLowerCase().includes(r.analysis.chain.toLowerCase())
  ? `${r.analysis.chain} · ${r.store}` : r.store ?? r.analysis?.chain ?? "Scontrino";
const txLabel = (t: LinkedTx) => `${t.bankName ?? t.accountName ?? "Conto"} · ${date(t.bookingDate, { day: "numeric", month: "short" })}`;

export function ReceiptsPage() {
  const [list, setList] = useState<Receipt[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ photo: Blob | null; preview: string | null; reading: ReceiptReading | null; reading_: boolean; readErr: string | null; edit?: Receipt } | null>(null);
  const [detail, setDetail] = useState<Receipt | null>(null);
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);

  const reload = () => listReceipts().then((l) => { setList(l); setErr(null); setDetail((d) => (d ? l.find((x) => x.id === d.id) ?? null : null)); }, (e: Error) => setErr(e.message));
  useEffect(() => { if (cloudEnabled) reload(); }, []);

  const onPhoto = async (file: File | undefined) => {
    if (camera.current) camera.current.value = "";
    if (gallery.current) gallery.current.value = "";
    if (!file) return;
    try {
      const photo = await shrinkPhoto(file);
      setDraft({ photo, preview: URL.createObjectURL(photo), reading: null, reading_: true, readErr: null });
      readReceipt(photo).then(
        (reading) => setDraft((d) => (d && d.photo === photo ? { ...d, reading, reading_: false } : d)),
        (e: Error) => setDraft((d) => (d && d.photo === photo ? { ...d, reading_: false, readErr: e.message } : d)),
      );
    } catch (e) { setErr((e as Error).message); }
  };
  const closeDraft = () => { if (draft?.preview) URL.revokeObjectURL(draft.preview); setDraft(null); };

  const month = todayIso().slice(0, 7);
  const stats = useMemo(() => {
    const m = (list ?? []).filter((r) => r.purchaseDate.startsWith(month));
    return {
      spent: m.reduce((s, r) => s + r.total, 0), count: m.length,
      linked: (list ?? []).filter((r) => r.tx).length, waiting: (list ?? []).filter((r) => !r.tx && r.match !== "nessuno").length,
      saving: m.reduce((s, r) => s + (r.items ? savings(r.items).bestMix : 0), 0),
    };
  }, [list, month]);

  if (!cloudEnabled) {
    return (
      <div className="page">
        <header className="page-head"><div><h1>Scontrini</h1></div></header>
        <Card><Empty icon={<ShoppingCart />} title="Disponibile nella versione online">Le foto degli scontrini si salvano su Supabase.</Empty></Card>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-head">
        <div><h1>Scontrini</h1><p className="sub">Fotografa lo scontrino: lo collego alla spesa sul conto e ti dico dove costava meno</p></div>
        <div className="head-actions">
          <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => onPhoto(e.target.files?.[0])} />
          <input ref={gallery} type="file" accept="image/*" hidden onChange={(e) => onPhoto(e.target.files?.[0])} />
          <button className="btn primary" onClick={() => camera.current?.click()}><Camera size={16} />Fotografa scontrino</button>
          <button className="btn" onClick={() => gallery.current?.click()}><ImageIcon size={16} />Dalla galleria</button>
        </div>
      </header>
      <ErrorBanner message={err} />
      <div className="stats">
        <Stat label="Spesa del mese" value={money(stats.spent)} hint={`${stats.count} ${stats.count === 1 ? "scontrino" : "scontrini"}`} />
        <Stat label="Potevi risparmiare" value={money(stats.saving)} tone={stats.saving > 0 ? "good" : undefined} hint="questo mese, comprando ogni prodotto dove costa meno" />
        <Stat label="Collegati al conto" value={`${stats.linked}/${(list ?? []).length}`} hint={stats.waiting ? `${stats.waiting} in attesa del movimento` : "Tutto collegato"} />
      </div>
      <Card>
        {list && list.length === 0 ? (
          <Empty icon={<ShoppingCart />} title="Nessuno scontrino">Tocca «Fotografa scontrino» alla cassa o appena arrivi a casa. Lo collego da solo al pagamento quando arriva il movimento della banca.</Empty>
        ) : (
          <ul className="list">
            {(list ?? []).map((r) => {
              const s = r.items ? savings(r.items) : null;
              return (
                <li key={r.id}>
                  <button className="row row-btn" onClick={() => setDetail(r)}>
                    <span className="row-icon"><Store size={16} aria-hidden /></span>
                    <span className="row-main">
                      <span className="row-title">{storeName(r)}</span>
                      <span className="row-sub">
                        {date(r.purchaseDate, { day: "numeric", month: "short" })}{r.purchaseTime ? ` · ${r.purchaseTime.slice(0, 5)}` : ""}
                        {r.items ? ` · ${r.items.filter((i) => i.amount > 0).length} prodotti` : ""}
                      </span>
                      <span className="row-sub">
                        {r.tx ? <span className="badge good"><CheckCircle2 size={12} aria-hidden />{txLabel(r.tx)}</span>
                          : r.match === "nessuno" ? <span className="badge neutral">Non collegato</span>
                          : <span className="badge neutral"><Clock size={12} aria-hidden />In attesa del movimento</span>}
                      </span>
                    </span>
                    <span className="right">
                      <span className="num">{money(r.total)}</span>
                      {s && s.bestMix > 0 && <span className="num pos">−{money(s.bestMix)}</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      {draft && <ReceiptForm draft={draft} onClose={closeDraft} onSaved={() => { closeDraft(); reload(); }} />}
      {detail && !draft && (
        <ReceiptDetail r={detail} onClose={() => setDetail(null)} onChanged={reload}
          onEdit={() => setDraft({ photo: null, preview: null, reading: null, reading_: false, readErr: null, edit: detail })}
          onReread={async () => {
            const photo = await photoBlob(detail.filePath!);
            setDraft({ photo: null, preview: null, reading: null, reading_: true, readErr: null, edit: detail });
            readReceipt(photo).then((reading) => setDraft((d) => (d ? { ...d, reading, reading_: false } : d)),
              (e: Error) => setDraft((d) => (d ? { ...d, reading_: false, readErr: e.message } : d)));
          }} />
      )}
    </div>
  );
}

function ReceiptForm({ draft, onClose, onSaved }: {
  draft: { photo: Blob | null; preview: string | null; reading: ReceiptReading | null; reading_: boolean; readErr: string | null; edit?: Receipt };
  onClose: () => void; onSaved: () => void;
}) {
  const e = draft.edit;
  const [f, setF] = useState({ store: e?.store ?? "", purchaseDate: e?.purchaseDate ?? todayIso(), purchaseTime: e?.purchaseTime?.slice(0, 5) ?? "",
    total: e ? e.total.toFixed(2).replace(".", ",") : "", notes: e?.notes ?? "" });
  const [touched, setTouched] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const r = draft.reading;
  // Quando arriva la lettura, riempie i campi non ancora toccati.
  useEffect(() => {
    if (!r || touched) return;
    setF((x) => ({ ...x, store: r.store ?? x.store, purchaseDate: r.date ?? x.purchaseDate, purchaseTime: r.time ?? x.purchaseTime,
      total: r.total != null ? r.total.toFixed(2).replace(".", ",") : x.total }));
  }, [r, touched]);
  const set = (k: keyof typeof f) => (ev: { target: { value: string } }) => { setTouched(true); setF({ ...f, [k]: ev.target.value }); };
  const sum = r ? r.items.reduce((s, i) => s + i.amount, 0) : null;

  const save = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const total = Number(f.total.replace(/\./g, "").replace(",", "."));
    if (!Number.isFinite(total) || total <= 0) { setErr("Totale non valido"); return; }
    setSaving(true);
    try {
      const input = { store: f.store, purchaseDate: f.purchaseDate, purchaseTime: f.purchaseTime, total, notes: f.notes, reading: r };
      if (e) await updateReceipt(e.id, input); else await createReceipt(input, draft.photo);
      onSaved();
    } catch (x) { setErr((x as Error).message); } finally { setSaving(false); }
  };

  return (
    <Modal title={e ? "Modifica scontrino" : "Nuovo scontrino"} onClose={onClose}>
      <form onSubmit={save} className="form">
        <ErrorBanner message={err} />
        {draft.preview && <img className="receipt-thumb wide" src={draft.preview} alt="Foto dello scontrino" />}
        {draft.reading_ && <div className="banner info wide"><RefreshCw size={16} className="spin" aria-hidden />Sto leggendo lo scontrino e confrontando i prezzi… (circa 20 secondi)</div>}
        {draft.readErr && <div className="banner critical wide">{draft.readErr}</div>}
        {r && <div className="banner info wide">{r.items.length} righe lette{sum != null && r.total != null && Math.abs(sum - r.total) > 0.01 ? `: la somma fa ${money(sum)}, controlla il totale` : ""}. Controlla e salva.</div>}
        <Field label="Negozio"><input value={f.store} onChange={set("store")} placeholder="Es. Lidl via Nizza" /></Field>
        <Field label="Totale (€)"><input required inputMode="decimal" value={f.total} onChange={set("total")} placeholder="0,00" /></Field>
        <Field label="Data"><input required type="date" value={f.purchaseDate} onChange={set("purchaseDate")} /></Field>
        <Field label="Ora"><input type="time" value={f.purchaseTime} onChange={set("purchaseTime")} /></Field>
        <Field label="Note" wide><input value={f.notes} onChange={set("notes")} /></Field>
        <div className="form-actions"><button type="button" className="btn" onClick={onClose}>Annulla</button>
          <button className="btn primary" disabled={saving}>{saving ? "Salvataggio…" : draft.reading_ ? "Salva senza aspettare" : "Salva"}</button></div>
      </form>
    </Modal>
  );
}

function ReceiptDetail({ r, onClose, onChanged, onEdit, onReread }: { r: Receipt; onClose: () => void; onChanged: () => void; onEdit: () => void; onReread: () => Promise<void> }) {
  const [err, setErr] = useState<string | null>(null);
  const [cands, setCands] = useState<LinkedTx[] | null>(null);
  const s = r.items ? savings(r.items) : null;
  const act = (p: Promise<unknown>) => p.then(() => { setErr(null); onChanged(); }, (e: Error) => setErr(e.message));
  useEffect(() => { if (!r.tx) candidates(r.id).then(setCands, () => setCands([])); else setCands(null); }, [r.id, r.tx]);
  const openPhoto = async () => {
    const win = window.open("about:blank", "_blank");
    try { const url = await photoUrl(r.filePath!); if (win) win.location.href = url; else window.location.href = url; }
    catch (e) { win?.close(); setErr((e as Error).message); }
  };

  return (
    <Modal title={storeName(r)} onClose={onClose}>
      <ErrorBanner message={err} />
      <dl className="facts">
        <dt>Totale</dt><dd className="num">{money(r.total)}</dd>
        <dt>Data</dt><dd>{date(r.purchaseDate)}{r.purchaseTime ? ` alle ${r.purchaseTime.slice(0, 5)}` : ""}</dd>
        {r.storeAddress && <><dt>Indirizzo</dt><dd>{r.storeAddress}</dd></>}
        <dt>Sul conto</dt>
        <dd>{r.tx ? <>{r.tx.description ?? r.tx.counterparty ?? "Movimento"} · {money(r.tx.amount)} · {txLabel(r.tx)}{r.match === "manuale" ? " (scelto da te)" : ""}</>
          : r.match === "nessuno" ? "Non collegato" : "In attesa del movimento: lo collego da solo al prossimo aggiornamento della banca"}</dd>
      </dl>

      {!r.tx && cands && cands.length > 0 && (
        <div className="receipt-block">
          <h3 className="mini-head">Potrebbe essere uno di questi movimenti</h3>
          <ul className="list">{cands.slice(0, 4).map((t) => (
            <li key={`${t.accountId}/${t.id}`} className="row">
              <span className="row-main"><span className="row-title">{t.description ?? t.counterparty ?? "Movimento"}</span>
                <span className="row-sub">{money(t.amount)} · {txLabel(t)}{t.exact ? "" : " · importo diverso"}</span></span>
              <button className="btn" onClick={() => act(linkTx(r.id, t))}><Link2 size={16} />Collega</button>
            </li>))}
          </ul>
        </div>
      )}

      {s && s.cheaper.length > 0 && (
        <div className="receipt-block">
          <h3 className="mini-head">Dove costava meno</h3>
          {s.stores[0] && s.stores[0].saving > 0 && (
            <p className="hint">Tutta la spesa da <strong>{s.stores[0].store}</strong>: circa {money(s.stores[0].total)} invece di {money(s.paid)} (−{money(s.stores[0].saving)}). Ogni prodotto dove costa meno: −{money(s.bestMix)}.</p>
          )}
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Prodotto</th><th className="right">Pagato</th><th>Meglio</th></tr></thead>
              <tbody>{s.cheaper.map((c, n) => (
                <tr key={n}><td>{c.product}{c.detail && <div className="cell-sub">{c.detail}</div>}</td><td className="right num">{money(c.paid)}</td>
                  <td className="num nowrap">{c.store} {money(c.price)}</td></tr>))}</tbody>
            </table>
          </div>
        </div>
      )}
      {s && s.cheaper.length === 0 && <p className="hint">Nessun prodotto costava meno nei supermercati del listino.</p>}

      {!!r.analysis?.tips.length && (
        <div className="receipt-block">
          <h3 className="mini-head">Consigli</h3>
          {r.analysis.summary && <p className="hint">{r.analysis.summary}</p>}
          <ul className="list">{r.analysis.tips.map((t, n) => <li key={n} className="row"><span className="row-icon"><Lightbulb size={16} aria-hidden /></span><span className="row-main row-sub block">{t}</span></li>)}</ul>
        </div>
      )}

      {!!r.items?.length && (
        <details className="receipt-block">
          <summary>Tutte le righe ({r.items.length})</summary>
          <div className="table-wrap"><table className="table">
            <tbody>{r.items.map((i, n) => <tr key={n}><td>{i.product}<div className="cell-sub">{i.description} · {i.category}</div></td><td className="right num">{money(i.amount)}</td></tr>)}</tbody>
          </table></div>
        </details>
      )}
      {r.notes && <p className="hint">{r.notes}</p>}

      <div className="form-actions wrap">
        {r.tx && <button className="btn" onClick={() => act(linkTx(r.id, null))}><Unlink size={16} />Scollega</button>}
        {r.filePath && <button className="btn" onClick={openPhoto}><ImageIcon size={16} />Foto</button>}
        {r.filePath && <button className="btn" onClick={() => onReread().catch((e: Error) => setErr(e.message))}><RefreshCw size={16} />Rileggi</button>}
        <button className="btn" onClick={onEdit}><Pencil size={16} />Modifica</button>
        <button className="btn" onClick={() => confirm("Eliminare lo scontrino e la sua foto?") && deleteReceipt(r).then(() => { onClose(); onChanged(); }, (e: Error) => setErr(e.message))}><Trash2 size={16} />Elimina</button>
      </div>
    </Modal>
  );
}
