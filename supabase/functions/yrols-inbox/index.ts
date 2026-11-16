// Edge Function "yrols-inbox": casella che riceve le bollette PDF scaricate dalle aree clienti dei fornitori
// (attività programmata di Claude desktop sul PC di casa). Non legge il PDF: lo salva nel bucket privato
// "yrols-fatture" (portale/<hash>.pdf) e lo mette in coda in yrols.portal_files; la lettura su GitHub Actions
// ne estrae i dati e lo aggiunge alle bollette.
//
// POST con header x-yrols-key: <chiave personale> e il PDF in uno di questi formati:
//   - corpo application/pdf, con ?provider=Fastweb&filename=fattura.pdf
//   - JSON { pdfBase64, provider?, filename? }
// Risposta: { ok: true, duplicate: boolean } (lo stesso PDF inviato due volte entra una volta sola).
//
// Secret della funzione: YROLS_INBOX_KEY (almeno 32 caratteri). Senza, la casella è chiusa.

import { createClient } from "npm:@supabase/supabase-js@2";

const env = (k: string) => Deno.env.get(k) ?? "";
const MAX_BYTES = 10 * 1024 * 1024;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "x-yrols-key, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

/** Confronto a tempo costante: non rivela quanti caratteri della chiave sono giusti. */
function sameKey(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const clean = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/[\u0000-\u001f]/g, "").trim().slice(0, max) : "") || null;

function fromBase64(s: string): Uint8Array {
  const bin = atob(s.replace(/^data:[^,]*,/, "").replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { error: "Usa POST" });
  const expected = env("YROLS_INBOX_KEY");
  if (expected.length < 32) return json(503, { error: "Casella non configurata (secret YROLS_INBOX_KEY)" });
  if (!sameKey(req.headers.get("x-yrols-key") ?? "", expected)) return json(401, { error: "Chiave non valida" });

  try {
    const q = new URL(req.url).searchParams;
    let pdf: Uint8Array, provider: string | null, filename: string | null;
    if ((req.headers.get("Content-Type") ?? "").includes("application/json")) {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      if (typeof body.pdfBase64 !== "string") return json(400, { error: "pdfBase64 mancante" });
      if (body.pdfBase64.length > MAX_BYTES * 1.4) return json(413, { error: "PDF oltre 10 MB" });
      pdf = fromBase64(body.pdfBase64);
      provider = clean(body.provider, 60); filename = clean(body.filename, 120);
    } else {
      pdf = new Uint8Array(await req.arrayBuffer());
      provider = clean(q.get("provider"), 60); filename = clean(q.get("filename"), 120);
    }
    if (pdf.byteLength > MAX_BYTES) return json(413, { error: "PDF oltre 10 MB" });
    if (new TextDecoder().decode(pdf.slice(0, 5)) !== "%PDF-") return json(415, { error: "Il file non è un PDF" });

    const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", pdf))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { db: { schema: "yrols" }, auth: { persistSession: false } });
    const { data: dup, error: dupErr } = await db.from("portal_files").select("id").eq("sha256", sha256).limit(1);
    if (dupErr) throw new Error(`Lettura coda: ${dupErr.message}`);
    if (dup?.length) return json(200, { ok: true, duplicate: true });

    const path = `portale/${sha256.slice(0, 32)}.pdf`;
    const up = await db.storage.from("yrols-fatture").upload(path, pdf, { contentType: "application/pdf", upsert: true });
    if (up.error) throw new Error(`Salvataggio PDF: ${up.error.message}`);
    const ins = await db.from("portal_files").insert({ sha256, provider, filename, file_path: path });
    if (ins.error && ins.error.code !== "23505") throw new Error(`Coda: ${ins.error.message}`);
    return json(200, { ok: true, duplicate: !!ins.error });
  } catch (e) {
    console.error((e as Error).message);
    return json(500, { error: "Errore interno, riprova più tardi" });
  }
});
