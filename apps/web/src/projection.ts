/** Carica movimenti, conti, bollette e scadenze e calcola la proiezione delle spese ricorrenti. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Account, type Bill, type Deadline, type Transaction } from "./api";
import { todayIso } from "./format";
import { findRecurring, projectMonth, type PlannedItem, type Projection, type Recurring } from "../../server/src/recurring.ts";

export type { Projection, Recurring };

interface Data { txs: Transaction[]; accounts: Account[]; planned: PlannedItem[] }

export const currentMonth = () => todayIso().slice(0, 7);
export const nextMonth = () => {
  const d = new Date(currentMonth() + "-15T12:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 7);
};

export function useProjection() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const from = new Date(Date.now() - 200 * 864e5).toISOString().slice(0, 10);
    // Bollette e scadenze sono un di più: se non si caricano la proiezione dalle banche resta valida.
    const soft = <T,>(p: Promise<T[]>) => p.catch(() => [] as T[]);
    Promise.all([
      api.get<Transaction[]>(`/banks/transactions?from=${from}&limit=2000`),
      api.get<Account[]>("/banks/accounts"),
      soft(api.get<Bill[]>("/bills")),
      soft(api.get<Deadline[]>("/deadlines")),
    ]).then(([txs, accounts, bills, deadlines]) => {
      const planned: PlannedItem[] = [
        ...bills.filter((b) => !b.paidAt).map((b) => ({ id: `b${b.id}`, label: b.provider, amount: b.amount, dueDate: b.dueDate, source: "bill" as const })),
        ...deadlines.filter((d) => !d.doneAt && d.amount).map((d) => ({ id: `d${d.id}`, label: d.title, amount: d.amount!, dueDate: d.dueDate, source: "deadline" as const })),
      ];
      setData({ txs, accounts, planned });
    }, (e: Error) => setError(e.message));
  }, []);

  const recurring = useMemo(() => data ? findRecurring(data.txs, data.accounts, todayIso()) : [], [data]);
  const project = useCallback((month: string) => data ? projectMonth(recurring, data.txs, month, todayIso(), data.planned) : null, [data, recurring]);
  return { loading: !data && !error, error, accounts: data?.accounts ?? [], recurring, project };
}
