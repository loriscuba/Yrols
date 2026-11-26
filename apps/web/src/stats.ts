/**
 * Statistiche personalizzate (solo versione online): le definizioni stanno in yrols.custom_stats,
 * i numeri si calcolano nel browser dai movimenti dei conti (logica in server/src/tripStats.ts).
 */
import { supabase } from "./cloud";
import { earliestNeeded, type Trip, type TripConfig, type TripTx } from "../../server/src/tripStats.ts";

import type { FamilyConfig } from "../../server/src/familyStats.ts";

export { computeFamily, FAMILY_LABELS, type FamilyConfig, type FamilyLine, type FamilyResult, type FamilyCategory } from "../../server/src/familyStats.ts";
export { computeTrips, CATEGORY_LABELS, COUNTRIES, flag, type Trip, type TripConfig, type TripResult, type TripLine } from "../../server/src/tripStats.ts";

const sb = () => { if (!supabase) throw new Error("Disponibile solo nella versione online"); return supabase; };
function ok<T>(r: { data: T; error: { message: string; code?: string } | null }): T {
  if (r.error) {
    if (r.error.code === "42P01" || r.error.code === "PGRST205" || /custom_stats/.test(r.error.message)) throw new Error("MISSING_TABLE");
    throw new Error(r.error.message);
  }
  return r.data;
}

interface Row { id: number; kind: string; title: string; config: TripConfig; position: number }

export async function listTrips(): Promise<Trip[]> {
  const rows = ok(await sb().from("custom_stats").select("id,kind,title,config,position").eq("kind", "vacanza").order("position").order("id")) as Row[];
  return rows.map((r) => ({ id: r.id, title: r.title, config: r.config }));
}

export async function saveTrip(t: { id?: number | string; title: string; config: TripConfig }) {
  const row = { kind: "vacanza", title: t.title.trim(), config: t.config };
  if (t.id !== undefined) ok(await sb().from("custom_stats").update(row).eq("id", Number(t.id)));
  else ok(await sb().from("custom_stats").insert(row));
}

export async function deleteTrip(id: number | string) {
  ok(await sb().from("custom_stats").delete().eq("id", Number(id)));
}

export interface FamilyStat { id: number; title: string; config: FamilyConfig }

export async function listFamily(): Promise<FamilyStat[]> {
  const rows = ok(await sb().from("custom_stats").select("id,title,config").eq("kind", "famiglia").order("position").order("id")) as FamilyStat[];
  return rows;
}

export async function saveFamily(f: FamilyStat) {
  ok(await sb().from("custom_stats").update({ title: f.title, config: f.config }).eq("id", f.id));
}

/** Movimenti dal giorno indicato (a pagine da 1000, il massimo della Data API) e conti propri. */
export async function loadMovements(trips: Trip[], months = 0) {
  const back = new Date(); back.setMonth(back.getMonth() - months);
  const from = [trips.length ? earliestNeeded(trips) : null, months ? back.toISOString().slice(0, 10) : null]
    .filter((d): d is string => !!d).sort()[0] ?? new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  const txs: TripTx[] = [];
  for (let page = 0; page < 20; page++) {
    const rows = ok(await sb().from("yrols_transactions").select("id,accountId,amount,bookingDate,description,counterparty,accountName,bankName")
      .gte("bookingDate", from).order("bookingDate").order("accountId").order("id").range(page * 1000, page * 1000 + 999)) as TripTx[];
    // L'id del movimento è unico solo dentro il suo conto.
    for (const r of rows) txs.push({ ...r, id: `${r.accountId}|${r.id}`, amount: Number(r.amount) });
    if (rows.length < 1000) break;
  }
  const accounts = ok(await sb().from("yrols_accounts").select("id,name")) as { id: string; name: string | null }[];
  return { txs, accounts };
}
