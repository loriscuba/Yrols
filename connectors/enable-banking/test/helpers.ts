import { generateKeyPairSync } from "node:crypto";

export const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

export interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: unknown;
}

type Handler = (call: Call) => { status?: number; body?: unknown } | undefined;

/** fetch finto che registra le chiamate e risponde con l'handler. */
export function mockFetch(handler: Handler) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? "GET",
      url,
      headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const r = handler(call) ?? { status: 404, body: { message: "not found" } };
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { fetch: f, calls };
}

/** Simula Enable Banking con una banca e un conto. */
export function fakeEnableBanking() {
  return mockFetch((c) => {
    const p = c.url.pathname;
    if (p === "/auth" && c.method === "POST") return { body: { url: "https://bank.example/consent?x=1", authorization_id: "auth-1" } };
    if (p === "/sessions" && c.method === "POST")
      return {
        body: {
          session_id: "sess-1",
          aspsp: { name: "Banca Test", country: "IT" },
          access: { valid_until: "2099-01-01T00:00:00Z" },
          accounts: [{ uid: "acc-1", account_id: { iban: "IT60X0542811101000000123456" }, name: "Conto famiglia", currency: "EUR" }],
        },
      };
    if (p === "/accounts/acc-1/balances")
      return {
        body: {
          balances: [
            { balance_amount: { currency: "EUR", amount: "2450.32" }, balance_type: "CLBD", reference_date: "2026-10-31" },
            { balance_amount: { currency: "EUR", amount: "2400.00" }, balance_type: "ITAV" },
          ],
        },
      };
    if (p === "/accounts/acc-1/transactions") {
      const key = c.url.searchParams.get("continuation_key");
      if (!key)
        return {
          body: {
            transactions: [
              {
                entry_reference: "tx-1",
                transaction_amount: { currency: "EUR", amount: "82.10" },
                credit_debit_indicator: "DBIT",
                status: "BOOK",
                booking_date: "2026-10-30",
                value_date: "2026-10-30",
                creditor: { name: "Enel Energia" },
                remittance_information: ["ADDEBITO SDD ENEL ENERGIA"],
              },
            ],
            continuation_key: "page2",
          },
        };
      return {
        body: {
          transactions: [
            {
              transaction_amount: { currency: "EUR", amount: "1500.00" },
              credit_debit_indicator: "CRDT",
              status: "PDNG",
              booking_date: "2026-10-27",
              debtor: { name: "Datore di lavoro SpA" },
              remittance_information: ["STIPENDIO OTTOBRE"],
            },
          ],
        },
      };
    }
    if (p === "/sessions/sess-1" && c.method === "DELETE") return { status: 200, body: {} };
    return undefined;
  });
}
