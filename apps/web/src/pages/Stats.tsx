import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { BarChart3, Eye, EyeOff, Pencil, Plane, Plus, Search, Trash2 } from "lucide-react";
import { cloudEnabled } from "../cloud";
import { date, money, moneyShort, todayIso } from "../format";
import { Card, Empty, ErrorBanner, Field, Modal, Stat } from "../components/ui";
import { computeTrips, COUNTRIES, deleteTrip, flag, listTrips, loadMovements, saveTrip, type Trip, type TripResult } from "../stats";

type Data = Awaited<ReturnType<typeof loadMovements>>;

const shortDate = (d: string) => date(d, { day: "numeric", month: "short" });
const range = (r: TripResult) => `${shortDate(r.from)} – ${r.trip.config.to ? date(r.to) : "in corso"}`;

export function StatsPage() {
  const [trips, setTrips] = useState<Trip[] | null>(null);
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [edit, setEdit] = useState<Trip | "new" | null>(null);

  const reload = async () => {
    try {
      const t = await listTrips();
      setTrips(t);
      setData(await loadMovements(t));
      setErr(null);
    } catch (e) {
      if ((e as Error).message === "MISSING_TABLE") setMissing(true); else setErr((e as Error).message);
    }
  };
  useEffect(() => { if (cloudEnabled) reload(); }, []);

  const results = useMemo(() => (trips && data ? computeTrips(trips, data.txs, data.accounts, todayIso()) : null), [trips, data]);
  const current = results?.find((r) => String(r.trip.id) === sel) ?? results?.[results.length - 1] ?? null;

  // Togliere o rimettere un movimento si vede subito; il salvataggio va in sottofondo.
  const toggle = async (trip: Trip, id: string, excluded: boolean) => {
    const exclude = new Set(trip.config.exclude ?? []);
    if (excluded) exclude.delete(id); else exclude.add(id);
    const next = { ...trip, config: { ...trip.config, exclude: [...exclude] } };
    setTrips((ts) => ts?.map((t) => (t.id === trip.id ? next : t)) ?? null);
    try { await saveTrip(next); } catch (e) { setErr((e as Error).message); reload(); }
  };

  if (!cloudEnabled) {
    return (
      <div className="page">
        <header className="page-head"><div><h1>Statistiche</h1></div></header>
        <Card><Empty icon={<BarChart3 />} title="Disponibile nella versione online">Le statistiche si calcolano dai movimenti salvati su Supabase.</Empty></Card>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-head">
        <div><h1>Statistiche</h1><p className="sub">Statistiche su misura dai tuoi movimenti. Chiedi a Claude quelle nuove che vuoi vedere.</p></div>
        {!missing && <button className="btn primary" onClick={() => setEdit("new")}><Plus size={16} />Nuova vacanza</button>}
      </header>
      <ErrorBanner message={err} />
      {missing && <Card><Empty icon={<BarChart3 />} title="Manca un ultimo passaggio">La tabella delle statistiche non è ancora nel database: Claude la aggiunge appena dai l'OK.</Empty></Card>}

      {!missing && (
        <>
          <h2 className="section-title"><Plane size={18} aria-hidden />Statistica Vacanza</h2>
          {!results ? <Card><p className="hint">Calcolo le spese dei viaggi…</p></Card> : results.length === 0 ? (
            <Card><Empty icon={<Plane />} title="Nessuna vacanza">Aggiungi un viaggio con le date: sommo da solo le spese fatte in quei giorni, senza giroconti né spese di casa.</Empty></Card>
          ) : (
            <>
              <div className="trip-pick" role="tablist">
                {results.map((r) => (
                  <button key={r.trip.id} role="tab" aria-selected={r === current} className={`trip-chip ${r === current ? "on" : ""}`} onClick={() => setSel(String(r.trip.id))}>
                    <span className="trip-flag" aria-hidden>{flag(r.trip.config.country)}</span>
                    <span className="row-main"><span className="row-title">{r.trip.title}</span><span className="row-sub">{range(r)}</span></span>
                    <span className="num">{money(r.total)}</span>
                  </button>
                ))}
              </div>
              {current && <TripDetail r={current} onEdit={() => setEdit(current.trip)} onToggle={(id, ex) => toggle(current.trip, id, ex)} />}
            </>
          )}
        </>
      )}
      {edit && data && (
        <TripForm trip={edit === "new" ? null : edit} data={data} onClose={() => setEdit(null)}
          onSaved={(id) => { setEdit(null); if (id !== undefined) setSel(String(id)); reload(); }} />
      )}
    </div>
  );
}

function TripDetail({ r, onEdit, onToggle }: { r: TripResult; onEdit: () => void; onToggle: (id: string, excluded: boolean) => void }) {
  const [showAll, setShowAll] = useState(false);
  const maxCat = Math.max(...r.byCategory.map((c) => c.total), 1);
  const lines = showAll ? r.lines : r.lines.slice(0, 25);
  return (
    <>
      <div className="stats">
        <Stat label={`Totale ${r.trip.title}`} value={money(r.total)} hint={`${r.count} spese · ${range(r)}`} />
        <Stat label="Al giorno" value={money(r.perDay)} hint={`${r.days} ${r.days === 1 ? "giorno" : "giorni"} di viaggio, esclusi voli e prenotazioni`} />
        <Stat label="Prima della partenza" value={money(r.before)} hint="voli e prenotazioni pagati in anticipo" />
      </div>
      <div className="grid-2">
        <Card title="Per tipo di spesa" action={<button className="btn" onClick={onEdit}><Pencil size={14} />Modifica viaggio</button>}>
          {r.byCategory.length === 0 ? <p className="hint">Nessuna spesa in questo periodo.</p> : (
            <ul className="hbars">
              {r.byCategory.map((c) => (
                <li key={c.category} title={`${c.label}: ${money(c.total)}`}>
                  <span className="hbar-label">{c.label}</span>
                  <span className="hbar-track"><span className="hbar-fill" style={{ width: `${(c.total / maxCat) * 100}%` }} /></span>
                  <span className="hbar-value">{money(c.total)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Dove hai speso di più">
          <ul className="list">
            {r.topMerchants.map((m) => (
              <li key={m.merchant} className="row">
                <span className="row-main"><span className="row-title">{m.merchant}</span><span className="row-sub">{m.count} {m.count === 1 ? "pagamento" : "pagamenti"}</span></span>
                <span className="num">{money(m.total)}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <Card title="Giorno per giorno">
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={r.byDay} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="20%">
            <CartesianGrid vertical={false} stroke="var(--grid)" />
            <XAxis dataKey="date" stroke="var(--text-muted)" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(d) => date(d, { day: "numeric" })} interval="preserveStartEnd" />
            <YAxis stroke="var(--text-muted)" fontSize={12} tickLine={false} axisLine={false} width={64} tickFormatter={moneyShort} />
            <Tooltip cursor={{ fill: "var(--hover)" }} labelFormatter={(d) => date(String(d), { weekday: "long", day: "numeric", month: "long" })}
              formatter={(v) => [money(Number(v)), "Spesa"]}
              contentStyle={{ background: "var(--surface-raised)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text-primary)", fontSize: 13 }} />
            <Bar dataKey="total" fill="var(--series-1)" radius={[4, 4, 0, 0]} maxBarSize={28} />
          </BarChart>
        </ResponsiveContainer>
      </Card>
      <Card title={`Movimenti del viaggio (${r.lines.length})`}>
        <p className="hint">Tocca l'occhio per togliere dal conto una spesa che non c'entra col viaggio (o rimetterla).</p>
        <ul className="list">
          {lines.map((l) => (
            <li key={l.id} className={`row ${l.excluded ? "muted" : ""}`}>
              <span className="row-main">
                <span className="row-title">{l.merchant}</span>
                <span className="row-sub">
                  {shortDate(l.date)} · {l.bankName ?? l.accountName ?? "Conto"}
                  {l.reason === "keyword" && <span className="badge neutral">prima/dopo il viaggio</span>}
                  {l.reason === "manual" && <span className="badge neutral">aggiunto a mano</span>}
                </span>
              </span>
              <span className={`num ${l.spent < 0 ? "pos" : ""}`}>{l.spent < 0 ? `+${money(-l.spent)}` : money(l.spent)}</span>
              <button className="icon-btn" onClick={() => onToggle(l.id, l.excluded)} aria-label={l.excluded ? "Rimetti nel conto" : "Togli dal conto"} title={l.excluded ? "Rimetti nel conto" : "Togli dal conto"}>
                {l.excluded ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </li>
          ))}
        </ul>
        {r.lines.length > 25 && <button className="btn" onClick={() => setShowAll(!showAll)}>{showAll ? "Mostra meno" : `Mostra tutti i ${r.lines.length}`}</button>}
      </Card>
    </>
  );
}

function TripForm({ trip, data, onClose, onSaved }: { trip: Trip | null; data: Data; onClose: () => void; onSaved: (id?: number | string) => void }) {
  const c = trip?.config;
  const [f, setF] = useState({ title: trip?.title ?? "", country: c?.country ?? "", from: c?.from ?? "", to: c?.to ?? "", keywords: (c?.keywords ?? []).join(", ") });
  const [include, setInclude] = useState<string[]>(c?.include ?? []);
  const [q, setQ] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const byId = useMemo(() => new Map(data.txs.map((t) => [t.id, t])), [data]);
  const found = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (s.length < 2) return [];
    return data.txs.filter((t) => t.amount < 0 && !include.includes(t.id) && `${t.description ?? ""} ${t.counterparty ?? ""}`.toLowerCase().includes(s))
      .sort((a, b) => (a.bookingDate < b.bookingDate ? 1 : -1)).slice(0, 8);
  }, [q, data, include]);

  const save = async () => {
    if (!f.title.trim()) return setErr("Dai un nome al viaggio");
    if (!f.from) return setErr("Indica il primo giorno del viaggio");
    if (f.to && f.to < f.from) return setErr("L'ultimo giorno viene prima del primo");
    setBusy(true);
    try {
      await saveTrip({ id: trip?.id, title: f.title, config: {
        ...c, country: f.country || null, from: f.from, to: f.to || null,
        keywords: f.keywords.split(",").map((k) => k.trim()).filter(Boolean), include,
      } });
      onSaved(trip?.id);
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  const remove = async () => {
    if (!trip) return;
    setBusy(true);
    try { await deleteTrip(trip.id); onSaved(); } catch (e) { setErr((e as Error).message); setBusy(false); }
  };

  return (
    <Modal title={trip ? "Modifica viaggio" : "Nuova vacanza"} onClose={onClose}>
      <div className="form">
        <Field label="Nome"><input value={f.title} onChange={set("title")} placeholder="Es. Giappone" autoFocus /></Field>
        <Field label="Paese">
          <select value={f.country} onChange={set("country")}>
            <option value="">—</option>
            {COUNTRIES.map(([cc, l]) => <option key={cc} value={cc}>{flag(cc)} {l}</option>)}
          </select>
        </Field>
        <Field label="Primo giorno"><input type="date" value={f.from} onChange={set("from")} /></Field>
        <Field label="Ultimo giorno (vuoto se in corso)"><input type="date" value={f.to} onChange={set("to")} /></Field>
        <Field label="Parole chiave per voli e prenotazioni" wide>
          <input value={f.keywords} onChange={set("keywords")} placeholder="Es. Turkish Airlines, Booking, Holafly" />
        </Field>
        <p className="hint wide">Conto le spese fatte tra il primo e l'ultimo giorno. Con le parole chiave aggiungo anche i pagamenti fatti fino a 4 mesi prima (voli, hotel, eSIM). Giroconti, ricariche e addebiti di casa non contano.</p>
        <div className="wide">
          <Field label="Aggiungi un movimento a mano" wide>
            <span className="search"><Search size={14} aria-hidden /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cerca nei movimenti" /></span>
          </Field>
          {found.length > 0 && (
            <ul className="list">
              {found.map((t) => (
                <li key={t.id}><button className="row row-btn" onClick={() => { setInclude([...include, t.id]); setQ(""); }}>
                  <span className="row-main"><span className="row-title">{t.counterparty || t.description}</span><span className="row-sub">{shortDate(t.bookingDate)} · {t.bankName}</span></span>
                  <span className="num">{money(-t.amount)}</span><Plus size={16} aria-hidden />
                </button></li>
              ))}
            </ul>
          )}
          {include.length > 0 && (
            <ul className="list">
              {include.map((id) => { const t = byId.get(id); return (
                <li key={id} className="row">
                  <span className="row-main"><span className="row-title">{t ? t.counterparty || t.description : "Movimento non più disponibile"}</span>
                    {t && <span className="row-sub">{shortDate(t.bookingDate)} · aggiunto a mano</span>}</span>
                  {t && <span className="num">{money(-t.amount)}</span>}
                  <button className="icon-btn" onClick={() => setInclude(include.filter((x) => x !== id))} aria-label="Togli"><Trash2 size={16} /></button>
                </li>
              ); })}
            </ul>
          )}
        </div>
        <div className="wide"><ErrorBanner message={err} /></div>
        <div className="form-actions wide">
          {trip && <button className="btn danger" disabled={busy} onClick={remove}><Trash2 size={14} />Elimina</button>}
          <button className="btn" onClick={onClose}>Annulla</button>
          <button className="btn primary" disabled={busy} onClick={save}>Salva</button>
        </div>
      </div>
    </Modal>
  );
}
