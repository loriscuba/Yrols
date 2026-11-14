/** Carica movimenti, bollette, proposte email e schede salvate e costruisce l'anagrafica fornitori. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Account, type Bill, type Suggestion, type Transaction } from "./api";
import { todayIso } from "./format";
import { findRecurring } from "../../server/src/recurring.ts";
import { buildSuppliers, type SavedSupplier, type Supplier } from "../../server/src/suppliers.ts";

export type { SavedSupplier, Supplier };

interface Data { txs: Transaction[]; accounts: Account[]; bills: Bill[]; emails: Suggestion[]; saved: SavedSupplier[] | null }

export function useSuppliers() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    const from = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
    const soft = <T,>(p: Promise<T[]>) => p.catch(() => [] as T[]);
    return Promise.all([
      api.get<Transaction[]>(`/banks/transactions?from=${from}&limit=2000`),
      api.get<Account[]>("/banks/accounts"),
      soft(api.get<Bill[]>("/bills")),
      soft(api.get<Suggestion[]>("/email/suggestions?status=pending")),
      // Senza la tabella (migrazione non ancora applicata) l'anagrafica funziona lo stesso, solo senza salvataggi.
      api.get<SavedSupplier[]>("/suppliers").catch(() => null),
    ]).then(([txs, accounts, bills, emails, saved]) => { setData({ txs, accounts, bills, emails, saved }); setError(null); },
      (e: Error) => setError(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  const suppliers = useMemo(() => {
    if (!data) return [];
    const today = todayIso();
    const recurring = findRecurring(data.txs, data.accounts, today);
    return buildSuppliers({
      txs: data.txs, recurring, today, saved: data.saved ?? [],
      bills: data.bills.map((b) => ({ id: b.id, provider: b.provider, kind: b.kind, amount: b.amount, dueDate: b.dueDate, paidAt: b.paidAt, invoiceNumber: b.invoiceNumber })),
      emails: data.emails.map((e) => ({ id: e.id, provider: e.provider, billKind: e.billKind, amount: e.amount, dueDate: e.dueDate, kind: e.kind })),
    });
  }, [data]);

  // Le utenze riconosciute diventano schede salvate, con la stima mensile aggiornata (la leggono altre pagine).
  useEffect(() => {
    if (!data?.saved) return;
    const jobs = suppliers.filter((s) => s.utility && !s.hidden).flatMap((s) => {
      const body = { monthly: s.monthly || null, directDebit: s.directDebit };
      if (!s.saved) return [api.post("/suppliers", { key: s.key, name: s.name, kind: s.kind, status: "attivo", ...body })];
      const changed = Math.abs(Number(s.saved.monthly ?? 0) - s.monthly) >= 0.5 || !!s.saved.directDebit !== s.directDebit;
      return changed ? [api.patch(`/suppliers/${s.saved.id}`, body)] : [];
    });
    if (jobs.length) Promise.allSettled(jobs).then((r) => { if (r.some((x) => x.status === "fulfilled")) load(); });
  }, [suppliers, data, load]);

  return { loading: !data && !error, error, accounts: data?.accounts ?? [], suppliers, canSave: !!data?.saved, reload: load };
}
