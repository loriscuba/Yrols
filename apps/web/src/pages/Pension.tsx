import { useEffect, useMemo, useRef, useState } from "react";
import { FileUp, Info, Landmark } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, Empty, ErrorBanner, Stat } from "../components/ui";
import { date, dateTime, money, moneyShort } from "../format";
import { isPending, paidBreakdown } from "../../../server/src/pension.ts";
import { importPension, loadPension, pensionGainPct, readPensionFiles, type PensionContribution, type PensionFund, type PensionHistory } from "../pension";

const pct = (n: number) => `${n > 0 ? "+" : ""}${n.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
const MONTHS = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"];
const period = (c: PensionContribution) => `${MONTHS[c.period - 1] ?? c.period} ${c.year}`;
const axis = { stroke: "var(--text-muted)", fontSize: 12, tickLine: false, axisLine: false } as const;

/**
 * Fondo pensione: ogni mese Loris carica l'Excel "importi versati" (e quando c'è il PDF "sintesi posizione")
 * scaricati dall'area riservata del fondo. I file si leggono nel browser; in Supabase vanno solo i numeri.
 */
export function PensionPage() {
  const [data, setData] = useState<{ fund: PensionFund | null; contributions: PensionContribution[]; history: PensionHistory[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [all, setAll] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const reload = () => loadPension().then(setData, (e: Error) => setErr(e.message));
  useEffect(() => { reload(); }, []);

  const onFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy(true); setErr(null); setMsg(null);
    try {
      const files = await readPensionFiles([...list]);
      const r = await importPension(files);
      const parts = [
        files.contributions && `${files.contributions.length} versamenti dall'Excel`,
        files.position && `sintesi del ${date(files.position.date)}`,
      ].filter(Boolean).join(" e ");
      setMsg(`Aggiornato con ${parts}: totale ${money(Number(r.total))}${r.estimated ? " (stima, carica anche la sintesi PDF per il valore esatto)" : ""}.`);
      await reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  const fund = data?.fund ?? null;
  const contributions = data?.contributions ?? [];
  const parts = useMemo(() => paidBreakdown(contributions), [contributions]);
  const pending = contributions.filter(isPending);
  const byYear = useMemo(() => {
    const m = new Map<number, number>();
    for (const c of contributions) if ((c.kind ?? "").toLowerCase() === "contributo") m.set(c.year, (m.get(c.year) ?? 0) + c.total);
    return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([year, total]) => ({ year: String(year), total: Math.round(total * 100) / 100 }));
  }, [contributions]);
  const gainPct = fund ? pensionGainPct(fund) : null;
  const shown = all ? contributions : contributions.slice(0, 12);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Fondo pensione</h1>
          <p className="sub">{fund ? `${fund.name}${fund.comparto ? ` · comparto ${fund.comparto}` : ""}` : "Versamenti e valore della posizione"}</p>
        </div>
        <div className="head-actions">
          <input ref={input} type="file" multiple hidden accept=".xlsx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => onFiles(e.target.files)} />
          <button className="btn primary" onClick={() => input.current?.click()} disabled={busy}>
            <FileUp size={16} />{busy ? "Lettura…" : "Carica Excel o PDF"}
          </button>
        </div>
      </header>
      <ErrorBanner message={err} />
      {msg && <div className="banner info" role="status">{msg}</div>}

      {data && !fund && (
        <Card>
          <Empty icon={<Landmark />} title="Nessun dato del fondo pensione">
            Dall'area riservata del fondo scarica l'Excel «Importi versati» e il PDF «Sintesi posizione», poi caricali qui (anche insieme).
          </Empty>
        </Card>
      )}

      {fund && (
        <>
          <div className="stats">
            <Stat label="Totale posizione" value={money(fund.total)}
              hint={fund.estimated ? <>Stima al {date(fund.totalDate)}: {money(fund.pdfTotal)} della sintesi + versamenti successivi</> : <>Al {date(fund.totalDate)}, dalla sintesi del fondo</>} />
            <Stat label="Importi versati" value={money(fund.paid)} hint={`${contributions.length} versamenti`} />
            <Stat label="Risultato della gestione" value={fund.result === null ? "—" : `${fund.result >= 0 ? "+" : ""}${money(fund.result)}`}
              tone={fund.result === null ? undefined : fund.result >= 0 ? "good" : "critical"}
              hint={gainPct !== null ? `${pct(gainPct)} sul versato, al netto di tasse e costi` : "Carica la sintesi PDF"} />
            <Stat label="Quote" value={fund.units === null ? "—" : fund.units.toLocaleString("it-IT", { minimumFractionDigits: 3 })}
              hint={fund.unitValue !== null ? `Valore quota ${fund.unitValue.toLocaleString("it-IT")} €${fund.unitValueDate ? ` al ${date(fund.unitValueDate)}` : ""}` : undefined} />
          </div>
          {fund.estimated && (
            <p className="hint"><Info size={14} aria-hidden /> L'Excel non contiene quote né valore quota: il totale esatto arriva con la sintesi PDF. Fino ad allora è stimato come ultimo totale noto più i nuovi versamenti.</p>
          )}

          <div className="grid-2">
            <Card title="Versato per tipo">
              <dl className="fund-facts">
                <div><dt>Contributi tuoi</dt><dd className="num">{money(parts.employee)}</dd></div>
                <div><dt>Contributi azienda</dt><dd className="num">{money(parts.employer)}</dd></div>
                <div><dt>TFR</dt><dd className="num">{money(parts.tfr)}</dd></div>
                {parts.transfer > 0 && <div><dt>Da altro fondo</dt><dd className="num">{money(parts.transfer)}</dd></div>}
                {parts.welfare > 0 && <div><dt>Premio di produzione</dt><dd className="num">{money(parts.welfare)}</dd></div>}
                {fund.invested !== null && <div><dt>Investito in quote</dt><dd className="num">{money(fund.invested)}</dd></div>}
                {(pending.length > 0 || fund.pending > 0) && (
                  <div><dt>In attesa di investimento</dt><dd className="num">{money(pending.length ? pending.reduce((s, c) => s + c.total, 0) : fund.pending)}</dd></div>
                )}
              </dl>
              {fund.allocation && Object.keys(fund.allocation).length > 0 && (
                <p className="hint">Composizione: {Object.entries(fund.allocation).map(([k, v]) => `${k} ${v.toLocaleString("it-IT")}%`).join(" · ")}</p>
              )}
              <p className="hint">
                {fund.excelAt && <>Excel caricato il {dateTime(fund.excelAt)}</>}
                {fund.excelAt && fund.pdfAt && " · "}
                {fund.pdfAt && <>sintesi del {date(fund.pdfDate)}</>}
              </p>
            </Card>
            <Card title="Contributi mensili per anno">
              {byYear.length ? (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={byYear} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid vertical={false} stroke="var(--grid)" />
                    <XAxis dataKey="year" {...axis} />
                    <YAxis {...axis} width={72} tickFormatter={moneyShort} />
                    <Tooltip cursor={{ fill: "var(--hover)" }} formatter={(v) => [money(Number(v)), "Versato"]}
                      contentStyle={{ background: "var(--surface-raised)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text-primary)", fontSize: 13 }} />
                    <Bar dataKey="total" fill="var(--series-1)" radius={[4, 4, 0, 0]} maxBarSize={48} />
                  </BarChart>
                </ResponsiveContainer>
              ) : <Empty icon={<Landmark />} title="Carica l'Excel degli importi versati" />}
            </Card>
          </div>

          {contributions.length > 0 && (
            <Card title="Versamenti" action={contributions.length > 12 && <button className="link-btn" onClick={() => setAll(!all)}>{all ? "Ultimi 12" : `Tutti (${contributions.length})`}</button>}>
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Mese</th><th className="right">Totale</th><th className="right hide-sm">Tuoi</th><th className="right hide-sm">Azienda</th><th className="right hide-sm">TFR</th><th>Stato</th></tr></thead>
                  <tbody>
                    {shown.map((c, i) => (
                      <tr key={i}>
                        <td>{period(c)}{c.kind && c.kind.toLowerCase() !== "contributo" && <div className="cell-sub">{c.kind}</div>}</td>
                        <td className="right num">{money(c.total)}</td>
                        <td className="right num hide-sm">{money(c.employee + c.voluntary)}</td>
                        <td className="right num hide-sm">{money(c.employer)}</td>
                        <td className="right num hide-sm">{money(c.tfr + c.tfrSilent + c.tfrRevaluation)}</td>
                        <td>{isPending(c) ? <span className="badge warning">In attesa</span> : <span className="badge neutral">{c.status ?? "—"}</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
