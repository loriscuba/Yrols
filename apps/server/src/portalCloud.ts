/**
 * Bollette arrivate dalle aree clienti (Edge Function yrols-inbox → coda yrols.portal_files), su GitHub Actions:
 * legge ogni PDF in coda e lo salva tra le bollette senza doppioni (yrols_save_invoice). Se mancano importo o
 * scadenza lo propone nella pagina "Da email" da completare. Nei log solo conteggi (repo e log pubblici).
 */
import { pdfToText } from "./pdfText.ts";
import { readPdf } from "./pdfNode.ts";
import { portalInvoice } from "./portalInvoice.ts";

const url = process.env.SUPABASE_URL?.replace(/\/+$/, "");
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.log("Supabase non configurato: niente da fare."); process.exit(0); }

const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Accept-Profile": "yrols", "Content-Profile": "yrols" };
async function rest(path: string, init: RequestInit = {}) {
  const res = await fetch(`${url}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  if (!res.ok) throw new Error(`Supabase ${res.status} su ${path.split("?")[0]}`);
  return res.status === 204 || res.status === 201 ? null : res.json();
}

// Se la coda non esiste ancora (migrazione non applicata) non si blocca la lettura delle email che segue.
const queue = (await rest("portal_files?select=id,sha256,provider,filename,file_path,received_at&processed_at=is.null&order=id&limit=50").catch((e) => {
  console.log(`Coda delle aree clienti non disponibile: ${(e as Error).message}`); return [];
})) as
  { id: number; sha256: string; provider: string | null; filename: string | null; file_path: string; received_at: string }[];
const count = { bill: 0, suggestion: 0, unreadable: 0, failed: 0 };
for (const f of queue) {
  try {
    const res = await fetch(`${url}/storage/v1/object/yrols-fatture/${f.file_path}`, { headers: { apikey: key!, Authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error(`PDF non scaricato (${res.status})`);
    let text = "";
    try { text = await pdfToText(readPdf, new Uint8Array(await res.arrayBuffer())); } catch { /* PDF protetto o rovinato */ }
    const r = portalInvoice(text, f.provider);
    let billId: number | null = null;
    if (r.result === "bill") {
      const out = (await rest("rpc/yrols_save_invoice", { method: "POST", body: JSON.stringify({ bill: {
        ...r.bill, filePath: f.file_path, source: "portale", notes: `Scaricata dall'area clienti ${r.bill.provider}`,
      } }) })) as { id: number };
      billId = out.id;
    } else if (r.result === "suggestion") {
      const b = r.bill;
      await rest("email_suggestions?on_conflict=message_id", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify([{
        message_id: `portale:${f.sha256}`, sender: `Area clienti ${b.provider}`, subject: f.filename ?? "Bolletta scaricata", received_at: f.received_at,
        kind: "bill", provider: b.provider, bill_kind: b.kind, title: `Bolletta ${b.provider}`, amount: b.amount, due_date: b.dueDate,
        snippet: "Scaricata dall'area clienti: completa i dati mancanti.", invoice_number: b.invoiceNumber, issue_date: b.issueDate,
        period_from: b.periodFrom, period_to: b.periodTo, items: b.items, file_path: f.file_path,
      }]) });
    }
    await rest(`portal_files?id=eq.${f.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ processed_at: new Date().toISOString(), result: r.result, bill_id: billId }) });
    count[r.result]++;
  } catch (e) {
    count.failed++; // si riprova al prossimo giro
    console.log(`Un PDF non elaborato, si riprova: ${(e as Error).message}`);
  }
}
console.log(`Bollette dalle aree clienti: ${queue.length} in coda, salvate ${count.bill}, da completare ${count.suggestion}, non fatture ${count.unreadable}, rimandate ${count.failed}`);
