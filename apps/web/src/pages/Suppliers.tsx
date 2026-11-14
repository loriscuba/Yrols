import { useState } from "react";
import { Building2, Droplets, EyeOff, Flame, Globe, Home, Landmark, Mail, Phone, Plus, ReceiptText, Repeat, Undo2, Wifi, Zap, Trash2 } from "lucide-react";
import { api, type Account } from "../api";
import { useSuppliers, type Supplier } from "../suppliers";
import { date, label, money } from "../format";
import { Card, Empty, ErrorBanner, Field, Modal, Stat } from "../components/ui";
import { slug } from "../../../server/src/suppliers.ts";

const KINDS = ["luce", "gas", "acqua", "internet", "telefono", "rifiuti", "condominio", "affitto", "mutuo", "altro"];
const ICONS: Record<string, typeof Zap> = { luce: Zap, gas: Flame, acqua: Droplets, internet: Wifi, telefono: Phone, condominio: Building2, affitto: Home, mutuo: Landmark };
const Icon = ({ kind }: { kind: string }) => { const I = ICONS[kind] ?? ReceiptText; return <I size={16} aria-hidden />; };

const accountLabel = (a: Account | undefined, id: string) => a ? `${a.bankName ?? "Banca"} · ${a.name ?? id}${a.iban ? ` …${a.iban.slice(-4)}` : ""}` : id;

function sourcesText(s: Supplier) {
  return [
    s.sources.bank && `${s.sources.bank} ${s.sources.bank === 1 ? "pagamento" : "pagamenti"} in banca`,
    s.sources.bills && `${s.sources.bills} ${s.sources.bills === 1 ? "bolletta" : "bollette"}`,
    s.sources.email && `${s.sources.email} da email`,
  ].filter(Boolean).join(" · ") || "Inserito a mano";
}

export function SuppliersPage() {
  const { loading, error, accounts, suppliers, canSave, reload } = useSuppliers();
  const [open, setOpen] = useState<Supplier | "new" | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const accById = new Map(accounts.map((a) => [a.id, a]));

  const utilities = suppliers.filter((s) => s.utility && !s.hidden);
  const others = suppliers.filter((s) => !s.utility && !s.hidden);
  const hidden = suppliers.filter((s) => s.hidden);
  const monthly = utilities.reduce((x, s) => x + s.monthly, 0);

  const act = (p: Promise<unknown>) => p.then(() => { setErr(null); setOpen(null); return reload(); }, (e: Error) => setErr(e.message));
  const save = (s: Supplier, body: Record<string, unknown>) =>
    act(s.saved ? api.patch(`/suppliers/${s.saved.id}`, body) : api.post("/suppliers", { key: s.key, name: s.name, kind: s.kind, monthly: s.monthly || null, directDebit: s.directDebit, ...body }));

  const row = (s: Supplier) => (
    <li key={s.key}>
      <button className="row-link row-btn" onClick={() => setOpen(s)}>
        <span className="row-icon"><Icon kind={s.kind} /></span>
        <span className="row-main">
          <span className="row-title">{s.name}</span>
          <span className="row-sub">{[label(s.kind), s.directDebit ? "addebito diretto" : null, sourcesText(s)].filter(Boolean).join(" · ")}</span>
        </span>
        <span className="right">
          <span className="num">{s.monthly ? `${money(s.monthly)}/mese` : "—"}</span>
          {s.lastPayment && <span className="row-sub block">ultimo {date(s.lastPayment.date, { day: "numeric", month: "short" })}</span>}
        </span>
      </button>
    </li>
  );

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Fornitori</h1>
          <p className="sub">Anagrafica delle utenze, riconosciuta da movimenti bancari, bollette ed email</p>
        </div>
        {canSave && <div className="head-actions"><button className="btn primary" onClick={() => setOpen("new")}><Plus size={16} />Nuovo fornitore</button></div>}
      </header>
      <ErrorBanner message={error ?? err} />
      {!loading && !canSave && !error && <div className="banner info">Le schede non si possono ancora salvare: manca la tabella dei fornitori nel database.</div>}
      {loading && <p className="hint">Riconosco i fornitori…</p>}
      {!loading && (
        <>
          <div className="stats">
            <Stat label="Fornitori di utenze" value={String(utilities.length)} hint={`${utilities.filter((s) => s.directDebit).length} con addebito diretto`} />
            <Stat label="Spesa media al mese" value={money(monthly)} />
            <Stat label="Stima annua" value={money(monthly * 12)} />
          </div>

          <Card title="Utenze">
            {utilities.length === 0
              ? <Empty icon={<Zap />} title="Nessun fornitore riconosciuto">Carica una bolletta o aspetta qualche movimento in banca.</Empty>
              : <ul className="list">{utilities.map(row)}</ul>}
          </Card>

          {others.length > 0 && (
            <Card title="Altri addebiti ricorrenti">
              <p className="hint proj-balance">Pagamenti che si ripetono ogni mese ma non sembrano utenze. Aprili per aggiungerli all'anagrafica o nasconderli.</p>
              <ul className="list">{others.map(row)}</ul>
            </Card>
          )}

          {hidden.length > 0 && (
            <p className="hint">
              <button className="link-btn" onClick={() => setShowHidden(!showHidden)}>{showHidden ? "Nascondi" : "Mostra"} {hidden.length} {hidden.length === 1 ? "fornitore nascosto" : "fornitori nascosti"}</button>
            </p>
          )}
          {showHidden && hidden.length > 0 && <Card title="Nascosti"><ul className="list">{hidden.map(row)}</ul></Card>}
        </>
      )}

      {open && (
        <SupplierModal supplier={open === "new" ? null : open} canSave={canSave} accLabel={(id) => accountLabel(accById.get(id), id)}
          onClose={() => setOpen(null)} error={err}
          onSave={(body) => open === "new"
            ? act(api.post("/suppliers", { key: slug(String(body.name)), status: "attivo", ...body }))
            : save(open, { ...body, status: "attivo" })}
          onHide={(hide) => open !== "new" && save(open, { status: hide ? "nascosto" : "attivo" })}
          onDelete={() => open !== "new" && open.saved && act(api.del(`/suppliers/${open.saved.id}`))} />
      )}
    </div>
  );
}

const FIELDS = [["customerCode", "Codice cliente"], ["contractCode", "Contratto / POD / PDR"], ["phone", "Telefono assistenza"], ["website", "Sito / area clienti"]] as const;

function SupplierModal({ supplier: s, canSave, accLabel, onClose, onSave, onHide, onDelete, error }: {
  supplier: Supplier | null; canSave: boolean; accLabel: (id: string) => string; error: string | null;
  onClose: () => void; onSave: (b: Record<string, unknown>) => void; onHide: (hide: boolean) => void; onDelete: () => void;
}) {
  const sv = s?.saved;
  const [f, setF] = useState<Record<string, string>>({
    name: s?.name ?? "", kind: s?.kind ?? "luce",
    customerCode: sv?.customerCode ?? "", contractCode: sv?.contractCode ?? "", phone: sv?.phone ?? "", website: sv?.website ?? "", notes: sv?.notes ?? "",
  });
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const manualOnly = s && !s.sources.bank && !s.sources.bills && !s.sources.email;
  const site = f.website && (/^https?:\/\//.test(f.website) ? f.website : `https://${f.website}`);

  return (
    <Modal title={s ? s.name : "Nuovo fornitore"} onClose={onClose}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); onSave(f); }}>
        <ErrorBanner message={error} />
        {s && (
          <dl className="facts wide">
            <dt>Spesa media</dt><dd className="num">{s.monthly ? `${money(s.monthly)} al mese` : "—"}</dd>
            {s.directDebit && <><dt>Pagamento</dt><dd>Addebito diretto (SDD){s.creditorId ? ` · creditore ${s.creditorId}` : ""}</dd></>}
            {s.accountIds.length > 0 && <><dt>Conto</dt><dd>{s.accountIds.map(accLabel).join(", ")}</dd></>}
            {s.recurring.length > 0 && <><dt>Ricorrenza</dt><dd>{s.recurring.map((r) => r.perMonth > 1 ? `${r.perMonth} addebiti al mese` : `ogni mese verso il ${r.day}`).join(" + ")}</dd></>}
            <dt>Riconosciuto da</dt><dd>{sourcesText(s)}</dd>
          </dl>
        )}
        <Field label="Nome"><input required value={f.name} onChange={set("name")} placeholder="Es. Enel Energia" /></Field>
        <Field label="Tipo"><select value={f.kind} onChange={set("kind")}>{KINDS.map((k) => <option key={k} value={k}>{label(k)}</option>)}</select></Field>
        {FIELDS.map(([k, l]) => <Field key={k} label={l}><input value={f[k]} onChange={set(k)} /></Field>)}
        <Field label="Note" wide><textarea rows={2} value={f.notes} onChange={set("notes")} /></Field>
        {(f.phone || site) && (
          <p className="hint">
            {f.phone && <a href={`tel:${f.phone.replace(/\s/g, "")}`}><Phone size={14} aria-hidden /> Chiama</a>}{f.phone && site && " · "}
            {site && <a href={site} target="_blank" rel="noreferrer"><Globe size={14} aria-hidden /> Apri il sito</a>}
          </p>
        )}

        {s && s.payments.length > 0 && (
          <div className="wide">
            <h3 className="mini-head"><Repeat size={14} aria-hidden /> Ultimi pagamenti</h3>
            <ul className="list compact">
              {s.payments.slice(0, 6).map((p) => (
                <li key={p.id} className="row"><span className="row-main"><span className="row-title">{date(p.date)}</span><span className="row-sub">{accLabel(p.accountId)}</span></span><span className="num">{money(p.amount)}</span></li>
              ))}
            </ul>
          </div>
        )}
        {s && s.bills.length > 0 && (
          <div className="wide">
            <h3 className="mini-head"><ReceiptText size={14} aria-hidden /> Bollette</h3>
            <ul className="list compact">
              {s.bills.slice(0, 6).map((b) => (
                <li key={b.id} className="row"><span className="row-main"><span className="row-title">{b.invoiceNumber ? `Fattura ${b.invoiceNumber}` : "Bolletta"}</span><span className="row-sub">scadenza {date(b.dueDate)}{b.paidAt ? " · pagata" : ""}</span></span><span className="num">{money(b.amount)}</span></li>
              ))}
            </ul>
          </div>
        )}
        {s && s.sources.email > 0 && <p className="hint wide"><Mail size={14} aria-hidden /> {s.sources.email} {s.sources.email === 1 ? "bolletta trovata" : "bollette trovate"} nelle email, da confermare nella pagina Da email.</p>}

        <div className="form-actions">
          {s && canSave && (manualOnly
            ? <button type="button" className="btn" onClick={onDelete}><Trash2 size={16} />Elimina</button>
            : <button type="button" className="btn" onClick={() => onHide(!s.hidden)}>{s.hidden ? <><Undo2 size={16} />Ripristina</> : <><EyeOff size={16} />Nascondi</>}</button>)}
          <button type="button" className="btn" onClick={onClose}>Chiudi</button>
          {canSave && <button className="btn primary">{s && !s.utility ? "Aggiungi all'anagrafica" : "Salva"}</button>}
        </div>
      </form>
    </Modal>
  );
}
