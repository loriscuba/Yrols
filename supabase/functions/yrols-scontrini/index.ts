// Edge Function "yrols-scontrini": legge la foto di uno scontrino con Claude e la confronta con il listino
// dei supermercati della zona (tabella yrols.grocery_prices). Non salva nulla: restituisce la lettura,
// la pagina Scontrini la mostra per conferma e poi salva foto e dati.
//
// POST JSON con Authorization: Bearer <sessione Supabase dell'utente>:
//   { imageBase64: "<jpeg/png/webp in base64>", mediaType?: "image/jpeg" }
// Risposta: { reading: ReceiptReading } oppure { error } (503 se manca la chiave Anthropic).
//
// Secret della funzione: ANTHROPIC_API_KEY. Opzionale YROLS_ALLOWED_ORIGINS.

import Anthropic from "npm:@anthropic-ai/sdk@0.137.0";
import { createClient } from "npm:@supabase/supabase-js@2";
import { normalizeReading, pricesForPrompt, READING_SCHEMA, SYSTEM_PROMPT, type GroceryPrice } from "../_shared/receipts.ts";

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return json(req, 405, { error: "Usa POST" });
  try {
    const db = await memberClient(req);
    const apiKey = env("ANTHROPIC_API_KEY");
    if (!apiKey) throw new HttpError(503, "Lettura automatica non attiva: manca la chiave Anthropic. Inserisci il totale a mano.");

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

    const client = new Anthropic({ apiKey });
    const msg = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: READING_SCHEMA } },
      system: SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
          { type: "text", text: `Listino dei supermercati della zona (catena | prodotto | formato | prezzo | prezzo unitario | data):\n${pricesForPrompt(prices)}` },
        ],
      }],
    } as unknown as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming);

    if (msg.stop_reason === "refusal") throw new HttpError(422, "Non sono riuscito a leggere lo scontrino: inserisci i dati a mano.");
    if (msg.stop_reason === "max_tokens") throw new HttpError(422, "Scontrino troppo lungo da leggere in una volta: inserisci il totale a mano.");
    const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { throw new HttpError(422, "Lettura non riuscita: riprova con una foto più nitida."); }
    return json(req, 200, { reading: normalizeReading(raw) });
  } catch (e) {
    if (e instanceof HttpError) return json(req, e.status, { error: e.message });
    if (e instanceof Anthropic.APIError) {
      console.error("anthropic", e.status);
      const status = e.status === 429 || (e.status ?? 0) >= 500 ? 503 : 502;
      return json(req, status, { error: status === 503 ? "Servizio di lettura occupato: riprova tra poco." : "Lettura non riuscita: controlla la chiave Anthropic." });
    }
    console.error("scontrini", (e as Error).message);
    return json(req, 500, { error: "Errore interno nella lettura" });
  }
});
