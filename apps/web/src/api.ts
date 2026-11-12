import { cloudEnabled, cloudRequest } from "./cloud";

export class ApiError extends Error {}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (cloudEnabled) {
    try { return await cloudRequest<T>(method, path, body); } catch (e) { throw new ApiError((e as Error).message); }
  }
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `Errore ${res.status}`);
  return data as T;
}

export const api = {
  get: <T>(p: string) => req<T>("GET", p),
  post: <T>(p: string, b: unknown = {}) => req<T>("POST", p, b),
  patch: <T>(p: string, b: unknown) => req<T>("PATCH", p, b),
  del: (p: string) => req<void>("DELETE", p),
};

export interface Account { id: string; connectionId: string | null; name: string | null; bankName: string | null; iban: string | null; currency: string; balance: number | null; balanceType: string | null; balanceDate: string | null; updatedAt: string }
export interface Transaction { id: string; accountId: string; amount: number; currency: string; bookingDate: string; description: string | null; counterparty: string | null; status: string; accountName: string | null; bankName: string | null }
export interface Connection { id: string; bankName: string | null; country: string | null; validUntil: string | null; status: string | null }
export interface InvoiceItem { description: string; amount: number; vat: number | null }
export interface Bill { id: number; provider: string; kind: string; amount: number; dueDate: string; periodFrom: string | null; periodTo: string | null; paidAt: string | null; notes: string | null;
  invoiceNumber?: string | null; issueDate?: string | null; items?: InvoiceItem[] | null; filePath?: string | null; source?: string }
export interface Deadline { id: number; title: string; category: string; dueDate: string; amount: number | null; recurrence: string; doneAt: string | null; notes: string | null }
export interface Reminder { id: number; text: string; remindAt: string | null; priority: string; doneAt: string | null }
export interface Suggestion { id: number; sender: string | null; subject: string | null; receivedAt: string | null; kind: "bill" | "deadline"; provider: string | null; billKind: string | null; title: string | null; amount: number | null; dueDate: string | null; snippet: string | null; status: string; invoiceNumber?: string | null; filePath?: string | null }
export interface AgendaItem { type: "bill" | "deadline" | "consent"; id: number | string; title: string; dueDate: string; amount: number | null; overdue: boolean }
export interface Overview {
  netWorth: number; accountsCount: number; last30: { income: number; expenses: number }; billsDueTotal: number; overdueCount: number;
  agenda: AgendaItem[]; reminders: Reminder[]; monthly: { month: string; income: number; expenses: number }[];
  billsByKind: { kind: string; total: number }[]; history: { date: string; total: number }[]; pendingEmail: number;
}
export interface Meta { billKinds: string[]; deadlineCategories: string[]; recurrences: string[]; priorities: string[] }
