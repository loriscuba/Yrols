import { useMemo, useState } from "react";
import { Check, ExternalLink, EyeOff, Flame, Lightbulb, PiggyBank, Settings2, Smartphone, Tv, Undo2, Wifi } from "lucide-react";
import { useData } from "../hooks";
import { api } from "../api";
import { cloudEnabled } from "../cloud";
import { useProjection } from "../projection";
import { date, dateTime, money } from "../format";
import { Card, Empty, ErrorBanner, Field, Modal, Stat } from "../components/ui";
import { currentSpend, isPromo, regularPrice, summarize, type SavingCategory, type SavingOffer, type SupplierLite } from "../../../server/src/savings.ts";

interface Profile {
  kwhYear: number | null; smcYear: number | null; powerKw: number | null; resident: boolean | null; province: string | null;
  internetMinMbps: number | null; mobileLines: number | null; mobileGb: number | null; notes: string | null; updatedAt?: string;
}
interface SavingsData {
  offers: SavingOffer[]; profile: Profile;
  lastRun: { runAt: string; sources: string[]; summary: string | null; offersCount: number } | null;
  suppliers: SupplierLite[] | null;
}

const ICON: Record<SavingCategory, typeof Wifi> = { luce: Lightbulb, gas: Flame, internet: Wifi, telefono: Smartphone, abbonamenti: Tv };

export function SavingsPage() {
  const { data, error, reload } = useData<SavingsData>("/savings");
  const { recurring } = useProjection();
  const [showHidden, setShowHidden] = useState(false);
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const summary = useMemo(() => {
    if (!data) return [];
    const cur = currentSpend(data.offers, data.suppliers, recurring.map((r) => ({ label: r.label, monthly: r.monthly })));
    return summarize(data.offers, cur, showHidden);
  }, [data, recurring, showHidden]);

  if (!cloudEnabled) {
    return (
      <div className="page">
        <header className="page-head"><div><h1>Risparmio</h1></div></header>
        <Card><Empty icon={<PiggyBank />} title="Disponibile nella versione online">Il controllo settimanale delle offerte scrive su Supabase.</Empty></Card>
      </div>
    );
  }

  const monthly = summary.reduce((s, c) => s + (c.monthlySaving ?? 0), 0);
  const fresh = (data?.offers ?? []).filter((o) => o.active && o.status === "nuova").length;
  const hidden = (data?.offers ?? []).filter((o) => o.active && o.status === "nascosta").length;
  const setStatus = (o: SavingOffer, status: SavingOffer["status"]) =>
    api.patch(`/savings/offers/${o.id}`, { status }).then(() => { setErr(null); reload(); }, (e: Error) => setErr(e.message));

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Risparmio</h1>
          <p className="sub">Offerte di luce, gas, internet e telefonia più convenienti di quello che paghi oggi, controllate ogni settimana</p>
        </div>
        <button className="btn" onClick={() => setEditing(true)}><Settings2 size={16} />I miei consumi</button>
      </header>
      <ErrorBanner message={error ?? err} />

      {data && (
        <>
          <div className="stats">
            <Stat label="Risparmio possibile" value={money(monthly * 12)} tone={monthly > 0 ? "good" : undefined}
              hint={monthly > 0 ? `all'anno a prezzi pieni, finite le promo (${money(monthly)} al mese)` : "Nessuna offerta più conveniente per ora"} />
            <Stat label="Offerte nuove" value={String(fresh)} hint="Da guardare" />
            <Stat label="Ultimo controllo" value={data.lastRun ? date(data.lastRun.runAt, { day: "numeric", month: "short" }) : "—"}
              hint={data.lastRun ? `${data.lastRun.offersCount} offerte · ${data.lastRun.sources.join(", ")}` : "Il primo controllo arriva entro una settimana"} />
          </div>

          {data.lastRun?.summary && <div className="banner info"><PiggyBank size={16} aria-hidden /><span>{data.lastRun.summary}</span></div>}

          {!data.profile.kwhYear && !data.profile.smcYear && (
            <p className="hint">Per luce e gas il confronto usa consumi stimati dalla spesa. Se indichi i consumi annui della bolletta in <button className="link-btn" onClick={() => setEditing(true)}>I miei consumi</button> la stima è più precisa.</p>
          )}

          {summary.length === 0 && (
            <Card><Empty icon={<PiggyBank />} title="Ancora nessuna offerta">Il controllo settimanale cerca le offerte e le confronta con le tue spese di luce, gas, internet e telefono.</Empty></Card>
          )}

          {summary.map((c) => {
            const Icon = ICON[c.category];
            return (
              <Card key={c.category}
                title={<span className="savings-title"><Icon size={18} aria-hidden />{c.label}</span>}
                action={c.monthlySaving ? <span className="badge good">Fino a {money(c.monthlySaving * 12)} l'anno in meno</span>
                  : c.offers.length ? <span className="badge neutral"><Check size={14} aria-hidden />Paghi già poco</span> : null}>
                <p className="hint proj-balance">
                  {c.current
                    ? <>Oggi: <strong>{c.current.provider}</strong>, circa {money(c.current.monthly)} al mese{c.current.from === "movimenti" ? " (dai movimenti in banca)" : ""}</>
                    : "Spesa attuale non riconosciuta"}
                </p>
                {c.offers.length === 0 ? <p className="hint">Nessuna offerta trovata in questo controllo.</p> : (
                  <ul className="list">
                    {c.offers.slice(0, 5).map((o) => (
                      <li key={o.id} className={`row ${o.status === "nascosta" ? "muted" : ""}`}>
                        <span className="row-main">
                          <span className="row-title">{o.provider} · {o.name}{o.status === "nuova" && <span className="badge neutral savings-new">Nuova</span>}</span>
                          <span className="row-sub">
                            {[o.priceType && `prezzo ${o.priceType}`, o.priceDetails, o.conditions, o.validUntil && `fino al ${date(o.validUntil)}`, `da ${o.source}`].filter(Boolean).join(" · ")}
                          </span>
                        </span>
                        <span className="savings-cost">
                          <span className="num">{money(regularPrice(o))}<span className="hint"> /mese{isPromo(o) ? " a regime" : ""}</span></span>
                          {isPromo(o) && (
                            <span className="badge warning" title="Prezzo promozionale: dopo sale al prezzo a regime">
                              {money(o.monthlyCost)} solo {o.promoMonths ? `per ${o.promoMonths} ${o.promoMonths === 1 ? "mese" : "mesi"}` : "all'inizio"}
                            </span>
                          )}
                          {o.saving != null && (o.saving > 0
                            ? <span className="num pos">−{money(o.saving * 12)} l'anno{isPromo(o) ? " dopo la promo" : ""}</span>
                            : <span className="hint">{o.saving === 0 ? "come oggi" : `+${money(-o.saving)} al mese${isPromo(o) ? " dopo la promo" : ""}`}</span>)}
                          {isPromo(o) && o.firstYearSaving != null && o.firstYearSaving > 0 && (
                            <span className="hint">primo anno −{money(o.firstYearSaving)}</span>
                          )}
                        </span>
                        <span className="actions">
                          {o.url && <a className="icon-btn" href={o.url} target="_blank" rel="noopener noreferrer" aria-label="Apri l'offerta"><ExternalLink size={16} /></a>}
                          {o.status === "nuova" && <button className="icon-btn" onClick={() => setStatus(o, "vista")} aria-label="Segna come vista"><Check size={16} /></button>}
                          {o.status === "nascosta"
                            ? <button className="icon-btn" onClick={() => setStatus(o, "vista")} aria-label="Mostra di nuovo"><Undo2 size={16} /></button>
                            : <button className="icon-btn" onClick={() => setStatus(o, "nascosta")} aria-label="Nascondi"><EyeOff size={16} /></button>}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            );
          })}

          {hidden > 0 && (
            <button className="link-btn savings-toggle" onClick={() => setShowHidden(!showHidden)}>
              {showHidden ? "Nascondi le offerte scartate" : `Mostra ${hidden} ${hidden === 1 ? "offerta nascosta" : "offerte nascoste"}`}
            </button>
          )}
          <p className="hint">I prezzi sono stime mensili con IVA e oneri, per i tuoi consumi. Il risparmio è calcolato sul prezzo a regime, cioè finite le promozioni; le offerte con prezzo scontato solo all'inizio hanno l'etichetta gialla. Le stime sono prese da comparatori pubblici e dai siti dei fornitori. Prima di cambiare controlla la scheda dell'offerta: vincoli, durata del prezzo bloccato, costi di attivazione.{data.profile.updatedAt ? ` Consumi aggiornati il ${dateTime(data.profile.updatedAt)}.` : ""}</p>
        </>
      )}

      {editing && data && <ProfileForm profile={data.profile} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); reload(); }} />}
    </div>
  );
}

function ProfileForm({ profile, onClose, onSaved }: { profile: Profile; onClose: () => void; onSaved: () => void }) {
  const [p, setP] = useState(profile);
  const [err, setErr] = useState<string | null>(null);
  const n = (k: keyof Profile) => ({
    type: "number", min: 0, step: "any", inputMode: "decimal" as const, value: (p[k] as number | null) ?? "",
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setP({ ...p, [k]: e.target.value === "" ? null : Number(e.target.value) }),
  });
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    api.patch("/savings/profile", p).then(onSaved, (x: Error) => setErr(x.message));
  };
  return (
    <Modal title="I miei consumi" onClose={onClose}>
      <form className="form" onSubmit={save}>
        <p className="hint wide">Li trovi in bolletta. Servono al controllo settimanale per stimare quanto pagheresti con ogni offerta; se li lasci vuoti li stima dalla spesa.</p>
        <Field label="Luce: consumo annuo (kWh)"><input {...n("kwhYear")} /></Field>
        <Field label="Gas: consumo annuo (Smc)"><input {...n("smcYear")} /></Field>
        <Field label="Potenza contatore (kW)"><input {...n("powerKw")} /></Field>
        <Field label="Provincia"><input value={p.province ?? ""} onChange={(e) => setP({ ...p, province: e.target.value || null })} placeholder="es. Milano" /></Field>
        <Field label="Internet: velocità minima (Mbit/s)"><input {...n("internetMinMbps")} /></Field>
        <Field label="Linee mobili"><input {...n("mobileLines")} /></Field>
        <Field label="Giga al mese per linea"><input {...n("mobileGb")} /></Field>
        <Field label="Residente nell'abitazione">
          <select value={p.resident === false ? "no" : "si"} onChange={(e) => setP({ ...p, resident: e.target.value === "si" })}>
            <option value="si">Sì</option><option value="no">No</option>
          </select>
        </Field>
        <Field label="Note per il confronto" wide><textarea rows={2} value={p.notes ?? ""} onChange={(e) => setP({ ...p, notes: e.target.value || null })} placeholder="es. voglio solo prezzo fisso, niente vincoli" /></Field>
        <ErrorBanner message={err} />
        <div className="form-actions wide">
          <button type="button" className="btn" onClick={onClose}>Annulla</button>
          <button className="btn primary">Salva</button>
        </div>
      </form>
    </Modal>
  );
}
