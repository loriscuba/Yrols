/**
 * Scontrini (solo versione online): foto ridotta nel browser, lettura con la funzione "yrols-scontrini",
 * foto nel bucket privato "yrols-scontrini", dati in yrols.receipts e collegamento al movimento del conto.
 */
import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase } from "./cloud";
import type { ReceiptItem, ReceiptReading } from "../../../supabase/functions/_shared/receipts.ts";

export type { ReceiptItem, ReceiptReading };
export { savings } from "../../../supabase/functions/_shared/receipts.ts";

const BUCKET = "yrols-scontrini";

export interface LinkedTx { accountId: string; id: string; amount: number; bookingDate: string; description: string | null; counterparty: string | null; accountName: string | null; bankName: string | null; exact?: boolean }
export interface Analysis { chain: string | null; electronicPayment: boolean; tips: string[]; summary: string | null }
export interface Receipt {
  id: number; store: string | null; storeVat: string | null; storeAddress: string | null; purchaseDate: string; purchaseTime: string | null;
  total: number; items: ReceiptItem[] | null; analysis: Analysis | null; analyzedAt: string | null; filePath: string | null;
  match: "auto" | "manuale" | "nessuno" | null; notes: string | null; createdAt: string; tx: LinkedTx | null;
}

const sb = () => { if (!supabase) throw new Error("Disponibile solo nella versione online"); return supabase; };
function ok<T>(r: { data: T; error: { message: string } | null }): T { if (r.error) throw new Error(r.error.message); return r.data; }

/** Riduce la foto (lato lungo 1600 px, JPEG): si carica in fretta anche col telefono e basta per leggerla. */
export async function shrinkPhoto(file: Blob, max = 1600): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * k); canvas.height = Math.round(bmp.height * k);
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("Foto non leggibile"))), "image/jpeg", 0.85));
}

const toBase64 = (b: Blob) => new Promise<string>((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).replace(/^data:[^,]*,/, ""));
  r.onerror = () => rej(new Error("Foto non leggibile"));
  r.readAsDataURL(b);
});

/** Legge lo scontrino. Se la lettura automatica non è attiva o non riesce, l'errore spiega cosa fare. */
export async function readReceipt(photo: Blob): Promise<ReceiptReading> {
  const { data, error } = await sb().functions.invoke("yrols-scontrini", { body: { imageBase64: await toBase64(photo), mediaType: "image/jpeg" } });
  if (error) {
    const msg = error instanceof FunctionsHttpError ? ((await error.context.json().catch(() => null)) as { error?: string } | null)?.error : null;
    throw new Error(msg ?? "Lettura automatica non disponibile: inserisci i dati a mano.");
  }
  return (data as { reading: ReceiptReading }).reading;
}

export const listReceipts = async () =>
  ok(await sb().from("yrols_receipts").select("*").order("purchaseDate", { ascending: false }).order("id", { ascending: false })) as unknown as Receipt[];

export interface ReceiptInput { store: string; purchaseDate: string; purchaseTime: string; total: number; reading: ReceiptReading | null; notes: string }

const columns = (f: ReceiptInput) => ({
  store: f.store.trim() || null, purchase_date: f.purchaseDate, purchase_time: f.purchaseTime || null, total: f.total, notes: f.notes.trim() || null,
  ...(f.reading ? {
    store_vat: f.reading.storeVat, store_address: f.reading.storeAddress, items: f.reading.items,
    analysis: { chain: f.reading.chain, electronicPayment: f.reading.electronicPayment, tips: f.reading.tips, summary: f.reading.summary },
    analyzed_at: new Date().toISOString(),
  } : {}),
});

/** Salva un nuovo scontrino con la sua foto e prova subito a collegarlo al movimento del conto. */
export async function createReceipt(f: ReceiptInput, photo: Blob | null): Promise<void> {
  let file_path: string | null = null;
  if (photo) {
    file_path = `foto/${crypto.randomUUID()}.jpg`;
    const up = await sb().storage.from(BUCKET).upload(file_path, photo, { contentType: "image/jpeg", upsert: false });
    if (up.error) throw new Error(`Foto non caricata: ${up.error.message}`);
  }
  const ins = await sb().from("receipts").insert({ ...columns(f), file_path });
  if (ins.error) {
    if (file_path) await sb().storage.from(BUCKET).remove([file_path]);
    throw new Error(ins.error.message);
  }
  await sb().rpc("yrols_match_receipts");
}

export async function updateReceipt(id: number, f: ReceiptInput): Promise<void> {
  ok(await sb().from("receipts").update(columns(f)).eq("id", id));
  await sb().rpc("yrols_match_receipts");
}

export async function deleteReceipt(r: Receipt): Promise<void> {
  ok(await sb().from("receipts").delete().eq("id", r.id));
  if (r.filePath) await sb().storage.from(BUCKET).remove([r.filePath]);
}

export const photoUrl = async (path: string) => ok(await sb().storage.from(BUCKET).createSignedUrl(path, 300))!.signedUrl;
export const photoBlob = async (path: string) => ok(await sb().storage.from(BUCKET).download(path)) as Blob;

export const candidates = async (id: number) => (ok(await sb().rpc("yrols_receipt_candidates", { receipt_id: id })) ?? []) as LinkedTx[];

export const linkTx = async (id: number, tx: LinkedTx | null) => {
  ok(await sb().from("receipts").update(tx ? { tx_account_id: tx.accountId, tx_id: tx.id, match: "manuale" } : { tx_account_id: null, tx_id: null, match: "nessuno" }).eq("id", id));
};
