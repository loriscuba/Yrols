import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CalendarClock, CheckCircle2, Clock, Repeat, TrendingDown } from "lucide-react";
import { currentMonth, nextMonth, useProjection } from "../projection";
import { date, money } from "../format";
import { Card, Empty, ErrorBanner, Segmented, Stat } from "../components/ui";

const monthName = (m: string) => date(m + "-15", { month: "long", year: "numeric" });

export function ProjectionPage() {
  const { loading, error, accounts, recurring, project } = useProjection();
  const [which, setWhich] = useState<"now" | "next">("now");
  const month = which === "now" ? currentMonth() : nextMonth();
  const p = useMemo(() => project(month), [project, month]);
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Spese previste</h1>
          <p className="sub">Pagamenti ricorrenti riconosciuti dai movimenti delle banche</p>
        </div>
        <Segmented value={which} onChange={setWhich} options={[["now", "Questo mese"], ["next", "Prossimo mese"]]} />
      </header>
      <ErrorBanner message={error} />
      {loading && <p className="hint">Analizzo i movimenti…</p>}
      {p && (
        <>
          <div className="stats">
            <Stat label={`Spesa prevista a ${monthName(month)}`} value={money(p.expected)}
              hint={`${recurring.length} ${recurring.length === 1 ? "pagamento ricorrente" : "pagamenti ricorrenti"}`} />
            {which === "now" && <Stat label="Già addebitato" value={money(p.paid)} />}
            <Stat label={which === "now" ? "Ancora da addebitare" : "Da addebitare"} value={money(p.remaining)} />
          </div>

          {p.accounts.length === 0 && p.planned.length === 0 && (
            <Card>
              <Empty icon={<Repeat />} title="Nessun pagamento ricorrente trovato">
                Servono almeno due o tre mesi di movimenti per riconoscere abbonamenti, bollette e rate.
              </Empty>
            </Card>
          )}

          {p.accounts.map((a) => {
            const acc = accountById.get(a.accountId);
            const after = which === "now" && acc?.balance != null ? acc.balance - a.remaining : null;
            return (
              <Card key={a.accountId}
                title={`${acc?.bankName ?? "Banca"} · ${acc?.name ?? a.accountId}${acc?.iban ? ` …${acc.iban.slice(-4)}` : ""}`}
                action={<span className="num">{money(a.expected)}</span>}>
                {after !== null && (
                  <p className="hint proj-balance">
                    Saldo oggi {money(acc!.balance, acc!.currency)} · dopo gli addebiti previsti <strong className={after < 0 ? "tone-critical" : ""}>{money(after, acc!.currency)}</strong>
                  </p>
                )}
                <ul className="list">
                  {a.items.map((i) => {
                    const r = i.recurring!;
                    const details = [
                      r.perMonth > 1 ? `${r.perMonth} addebiti al mese` : `Ogni mese verso il giorno ${r.day}`,
                      r.variable ? `importo variabile, in media ${money(r.monthly)}` : null,
                      r.directDebit ? "addebito diretto" : null,
                      `visto in ${r.months} mesi`,
                    ].filter(Boolean).join(" · ");
                    return (
                      <li key={r.key} className="row">
                        <span className="row-icon"><Repeat size={16} aria-hidden /></span>
                        <span className="row-main"><span className="row-title">{i.label}</span><span className="row-sub">{details}</span></span>
                        <span className="row-end">
                          <span className="num">{money(i.expected)}</span>
                          {i.remaining > 0
                            ? <span className="badge neutral"><Clock size={14} aria-hidden />{i.paid > 0 ? "Manca " + money(i.remaining) : date(i.nextDate, { day: "numeric", month: "short" })}</span>
                            : <span className="badge good"><CheckCircle2 size={14} aria-hidden />Addebitato</span>}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            );
          })}

          {p.planned.length > 0 && (
            <Card title="Bollette e scadenze in calendario" action={<span className="num">{money(p.planned.reduce((s, i) => s + i.expected, 0))}</span>}>
              <p className="hint proj-balance">Da Bollette e Scadenze, conto non indicato. Quelle già riconosciute tra i pagamenti ricorrenti non sono contate due volte.</p>
              <ul className="list">
                {p.planned.map((i) => (
                  <li key={i.planned!.id}>
                    <Link to={i.planned!.source === "bill" ? "/bollette" : "/scadenze"} className="row-link">
                      <span className="row-icon"><CalendarClock size={16} aria-hidden /></span>
                      <span className="row-main"><span className="row-title">{i.label}</span><span className="row-sub">{i.planned!.source === "bill" ? "Bolletta" : "Scadenza"} · {date(i.nextDate)}</span></span>
                      <span className="num">{money(i.expected)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <p className="hint"><TrendingDown size={14} aria-hidden /> La proiezione considera solo le uscite che si ripetono ogni mese (abbonamenti, utenze, rate, piani di accumulo). Giroconti tra i tuoi conti, spesa al supermercato e acquisti occasionali non sono inclusi.</p>
        </>
      )}
    </div>
  );
}
