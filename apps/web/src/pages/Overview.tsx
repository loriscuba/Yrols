import { Link } from "react-router-dom";
import { Bell, CalendarClock, KeyRound, Landmark, Mail, ReceiptText } from "lucide-react";
import { useData } from "../hooks";
import type { Overview } from "../api";
import { date, money, dateTime, label } from "../format";
import { Card, DueBadge, Empty, ErrorBanner, Stat } from "../components/ui";
import { BillsByKind, MonthlyFlowsChart, NetWorthChart } from "../components/Charts";

const AGENDA_ICON = { bill: ReceiptText, deadline: CalendarClock, consent: KeyRound };
const AGENDA_LINK = { bill: "/bollette", deadline: "/scadenze", consent: "/banche" };

export function OverviewPage() {
  const { data, error } = useData<Overview>("/overview");
  const greeting = new Date().getHours() < 13 ? "Buongiorno" : new Date().getHours() < 18 ? "Buon pomeriggio" : "Buonasera";

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{greeting}</h1>
          <p className="sub">{date(new Date().toISOString(), { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</p>
        </div>
      </header>
      <ErrorBanner message={error} />
      {data && (
        <>
          {data.pendingEmail > 0 && (
            <Link to="/email" className="banner info"><Mail size={16} aria-hidden />
              {data.pendingEmail === 1 ? "1 bolletta o scadenza trovata nelle email" : `${data.pendingEmail} bollette o scadenze trovate nelle email`}: controlla e conferma
            </Link>
          )}
          <div className="stats">
            <Stat label="Patrimonio sui conti" value={money(data.netWorth)} hint={`${data.accountsCount} ${data.accountsCount === 1 ? "conto" : "conti"}`} />
            <Stat label="Entrate ultimi 30 giorni" value={money(data.last30.income)} />
            <Stat label="Uscite ultimi 30 giorni" value={money(data.last30.expenses)} />
            <Stat label="Da pagare entro 30 giorni" value={money(data.billsDueTotal)}
              hint={data.overdueCount ? `${data.overdueCount} già scadute` : "Nessuna scaduta"} tone={data.overdueCount ? "critical" : undefined} />
          </div>

          <div className="grid-2">
            <Card title="In arrivo" action={<Link className="link" to="/scadenze">Tutte</Link>}>
              {data.agenda.length === 0 ? (
                <Empty icon={<CalendarClock />} title="Nessuna scadenza nei prossimi 30 giorni" />
              ) : (
                <ul className="list">
                  {data.agenda.slice(0, 8).map((a) => {
                    const Icon = AGENDA_ICON[a.type];
                    return (
                      <li key={a.type + a.id}>
                        <Link to={AGENDA_LINK[a.type]} className="row-link">
                          <span className="row-icon"><Icon size={16} aria-hidden /></span>
                          <span className="row-main"><span className="row-title">{a.title}</span><span className="row-sub">{date(a.dueDate)}</span></span>
                          {a.amount !== null && <span className="num">{money(a.amount)}</span>}
                          <DueBadge date={a.dueDate} />
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
            <Card title="Promemoria" action={<Link className="link" to="/promemoria">Gestisci</Link>}>
              {data.reminders.length === 0 ? (
                <Empty icon={<Bell />} title="Niente da ricordare" />
              ) : (
                <ul className="list">
                  {data.reminders.map((r) => (
                    <li key={r.id} className="row">
                      <span className={`prio prio-${r.priority}`} title={`Priorità ${label(r.priority)}`} aria-label={`Priorità ${label(r.priority)}`} />
                      <span className="row-main"><span className="row-title">{r.text}</span>{r.remindAt && <span className="row-sub">{dateTime(r.remindAt)}</span>}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <div className="grid-2">
            <Card title="Andamento del patrimonio">
              {data.history.length > 1 ? <NetWorthChart data={data.history} /> : (
                <Empty icon={<Landmark />} title="Nessun dato bancario ancora">Collega il connettore Enable Banking per vedere i saldi.</Empty>
              )}
            </Card>
            <Card title="Entrate e uscite per mese">
              {data.monthly.length ? <MonthlyFlowsChart data={data.monthly} /> : <Empty icon={<Landmark />} title="Nessun movimento" />}
            </Card>
          </div>
          {data.billsByKind.length > 0 && (
            <Card title="Bollette degli ultimi 12 mesi per tipo"><BillsByKind data={data.billsByKind} /></Card>
          )}
        </>
      )}
    </div>
  );
}
