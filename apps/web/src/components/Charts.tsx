import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { date, label, money, moneyShort, monthLabel } from "../format";

const axis = { stroke: "var(--text-muted)", fontSize: 12, tickLine: false, axisLine: false } as const;
const tooltipStyle = {
  contentStyle: { background: "var(--surface-raised)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text-primary)", fontSize: 13 },
  labelStyle: { color: "var(--text-secondary)", marginBottom: 4 },
  itemStyle: { color: "var(--text-primary)", padding: 0 },
};

export function NetWorthChart({ data }: { data: { date: string; total: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="nw" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--series-1)" stopOpacity={0.22} />
            <stop offset="100%" stopColor="var(--series-1)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke="var(--grid)" />
        <XAxis dataKey="date" {...axis} tickFormatter={(d) => date(d, { day: "numeric", month: "short" })} minTickGap={40} />
        <YAxis {...axis} width={72} tickFormatter={moneyShort} domain={["auto", "auto"]} />
        <Tooltip {...tooltipStyle} cursor={{ stroke: "var(--text-muted)", strokeDasharray: "3 3" }}
          labelFormatter={(d) => date(String(d))} formatter={(v) => [money(Number(v)), "Patrimonio"]} />
        <Area type="monotone" dataKey="total" stroke="var(--series-1)" strokeWidth={2} fill="url(#nw)"
          activeDot={{ r: 5, stroke: "var(--surface)", strokeWidth: 2 }} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function MonthlyFlowsChart({ data }: { data: { month: string; income: number; expenses: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={2} barCategoryGap="28%">
        <CartesianGrid vertical={false} stroke="var(--grid)" />
        <XAxis dataKey="month" {...axis} tickFormatter={monthLabel} />
        <YAxis {...axis} width={72} tickFormatter={moneyShort} />
        <Tooltip {...tooltipStyle} cursor={{ fill: "var(--hover)" }} labelFormatter={(m) => monthLabel(String(m))}
          formatter={(v, n) => [money(Number(v)), n === "income" ? "Entrate" : "Uscite"]} />
        <Legend iconType="circle" iconSize={8} formatter={(n) => <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>{n === "income" ? "Entrate" : "Uscite"}</span>} />
        <Bar dataKey="income" fill="var(--series-1)" radius={[4, 4, 0, 0]} maxBarSize={22} />
        <Bar dataKey="expenses" fill="var(--series-2)" radius={[4, 4, 0, 0]} maxBarSize={22} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Spesa bollette per tipo negli ultimi 12 mesi: barre orizzontali, una sola tinta, valori etichettati in testo. */
export function BillsByKind({ data }: { data: { kind: string; total: number }[] }) {
  const max = Math.max(...data.map((d) => d.total), 1);
  return (
    <ul className="hbars">
      {data.map((d) => (
        <li key={d.kind} title={`${label(d.kind)}: ${money(d.total)}`}>
          <span className="hbar-label">{label(d.kind)}</span>
          <span className="hbar-track"><span className="hbar-fill" style={{ width: `${(d.total / max) * 100}%` }} /></span>
          <span className="hbar-value">{money(d.total)}</span>
        </li>
      ))}
    </ul>
  );
}
