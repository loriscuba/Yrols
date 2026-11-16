// Edge Function "yrols-scontrini": legge la foto di uno scontrino con un servizio AI dal piano gratuito
// (Groq o Google Gemini) e la confronta con il listino dei supermercati della zona (yrols.grocery_prices).
// Non salva nulla: restituisce la lettura, la pagina Scontrini la mostra per conferma e poi salva foto e dati.
//
// POST JSON con Authorization: Bearer <sessione Supabase dell'utente>:
//   { imageBase64: "<jpeg/png/webp in base64>", mediaType?: "image/jpeg" }
// Risposta: { reading: ReceiptReading, provider } oppure { error } (503 se non c'è nessuna chiave).
//
// Secret della funzione (basta uno; se ci sono entrambi si prova prima Groq, poi Gemini):
//   GROQ_API_KEY   (console.groq.com, gratis)       — modello GROQ_MODEL, predefinito qwen/qwen3.8-27b
//   GEMINI_API_KEY (aistudio.google.com, gratis)    — modello GEMINI_MODEL, predefinito gemini-3.8-flash
// Opzionale YROLS_ALLOWED_ORIGINS.

import { createClient } from "npm:@supabase/supabase-js@2";
import { extractJson, normalizeReading, pricesForPrompt, SYSTEM_PROMPT, type GroceryPrice } from "../_shared/receipts.ts";

const env = (k: string) => Deno.env.get(k) ?? "";
const MAX_BASE64 = 8 * 1024 * 1024;
const MEDIA = ["image/jpeg", "image/png", "image/webp"] as const;
const ORIGINS = (env("YROLS_ALLOWED_ORIGINS") || "https://loriscuba.github.io,http://localhost:5173").split(",").map((s) => s.trim());

class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(origin) ? origin : ORIGINS[0]!,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
const json = (req: Request, status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });

async function memberClient(req: Request) {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new HttpError(401, "Accedi al cruscotto");
  const db = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: `Bearer ${token}` } }, db: { schema: "yrols" }, auth: { persistSession: false },
  });
  const { data: u, error: ue } = await db.auth.getUser();
  if (ue || !u.user) throw new HttpError(401, "Sessione scaduta: rientra nel cruscotto");
  const { data: member, error } = await db.rpc("yrols_is_member");
  if (error || member !== true) throw new HttpError(403, "Questo account non è abilitato al cruscotto");
  return db;
}

/** Errore del servizio AI: quota del piano gratuito finita, chiave sbagliata o servizio giù. */
class ProviderError extends Error { constructor(public status: number, public provider: string) { super(`${provider} ${status}`); } }

async function askGroq(key: string, image: string, mediaType: string, listino: string): Promise<string> {
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: env("GROQ_MODEL") || "qwen/qwen3.8-27b",
      temperature: 0.1,
      max_completion_tokens: 8000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: [
          { type: "image_url", image_url: { url: `data:${mediaType};base64,${image}` } },
          { type: "text", text: listino },
        ] },
      ],
    }),
  });
  if (!r.ok) throw new ProviderError(r.status, "groq");
  const data = await r.json() as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content ?? "";
}

async function askGemini(key: string, image: string, mediaType: string, listino: string): Promise<string> {
  const model = env("GEMINI_MODEL") || "gemini-3.8-flash";
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ inline_data: { mime_type: mediaType, data: image } }, { text: listino }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.1 },
    }),
  });
  if (!r.ok) throw new ProviderError(r.status, "gemini");
  const data = await r.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  return (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return json(req, 405, { error: "Usa POST" });
  try {
    const db = await memberClient(req);
    const providers = [
      env("GROQ_API_KEY") && { name: "groq", ask: (i: string, m: string, l: string) => askGroq(env("GROQ_API_KEY"), i, m, l) },
      env("GEMINI_API_KEY") && { name: "gemini", ask: (i: string, m: string, l: string) => askGemini(env("GEMINI_API_KEY"), i, m, l) },
    ].filter(Boolean) as { name: string; ask: (i: string, m: string, l: string) => Promise<string> }[];
    if (!providers.length) throw new HttpError(503, "Lettura automatica non attiva: manca la chiave di Groq o Gemini. Inserisci il totale a mano.");

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const image = typeof body.imageBase64 === "string" ? body.imageBase64.replace(/^data:[^,]*,/, "").replace(/\s+/g, "") : "";
    if (!image) throw new HttpError(400, "Foto mancante");
    if (image.length > MAX_BASE64) throw new HttpError(413, "Foto troppo grande");
    const mediaType = MEDIA.find((m) => m === body.mediaType) ?? "image/jpeg";

    // Listino: per ogni catena e prodotto, il prezzo rilevato più di recente.
    const { data: rows, error } = await db.from("grocery_prices")
      .select("store,product,detail,price,unit,unit_price,checked_on").order("checked_on", { ascending: false }).limit(600);
    if (error) throw new Error(`Listino non leggibile: ${error.message}`);
    const seen = new Set<string>();
    const prices = ((rows ?? []) as GroceryPrice[]).map((p) => ({ ...p, price: Number(p.price), unit_price: p.unit_price == null ? null : Number(p.unit_price) }))
      .filter((p) => { const k = `${p.store}|${p.product}|${p.detail ?? ""}`.toLowerCase(); return seen.has(k) ? false : (seen.add(k), true); });
    const listino = `Listino dei supermercati della zona (catena | prodotto | formato | prezzo | prezzo unitario | data):\n${pricesForPrompt(prices)}`;

    // Prova i servizi in ordine: se uno ha finito la quota gratuita o non risponde, passa al successivo.
    let last: ProviderError | null = null;
    for (const p of providers) {
      try {
        const text = await p.ask(image, mediaType, listino);
        let raw: unknown;
        try { raw = extractJson(text); } catch { throw new HttpError(422, "Lettura non riuscita: riprova con una foto più nitida."); }
        return json(req, 200, { reading: normalizeReading(raw), provider: p.name });
      } catch (e) {
        if (!(e instanceof ProviderError)) throw e;
        console.error("scontrini provider", e.provider, e.status);
        last = e;
      }
    }
    const quota = last?.status === 429;
    throw new HttpError(503, quota ? "Quota gratuita di oggi finita: riprova domani o inserisci il totale a mano."
      : last && (last.status === 401 || last.status === 403) ? "Chiave del servizio di lettura non valida: controllala in Supabase."
      : "Servizio di lettura non disponibile: riprova tra poco.");
  } catch (e) {
    if (e instanceof HttpError) return json(req, e.status, { error: e.message });
    console.error("scontrini", (e as Error).message);
    return json(req, 500, { error: "Errore interno nella lettura" });
  }
});
