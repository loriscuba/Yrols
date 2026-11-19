/**
 * Fondi senza API (es. PAC Fineco), su GitHub Actions: legge il NAV pubblico di ogni fondo in yrols.funds
 * e lo passa a yrols_fund_sync, che conta le rate del PAC e aggiorna valore e posizione.
 * Nei log solo conteggi e date (repo e log pubblici).
 */
import { ftUrl, mergeNavs, parseFamNav, parseFtNav, type Nav } from "./funds.ts";

const url = process.env.SUPABASE_URL?.replace(/\/+$/, "");
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.log("Supabase non configurato: niente da fare."); process.exit(0); }

const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Accept-Profile": "yrols", "Content-Profile": "yrols" };
async function rest(path: string, init: RequestInit = {}) {
  const res = await fetch(`${url}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  if (!res.ok) throw new Error(`Supabase ${res.status} su ${path.split("?")[0]}`);
  return res.json();
}

async function page(u: string): Promise<string | null> {
  try {
    const res = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0 (compatible; yrols-nav/1.0)", Accept: "text/html" }, signal: AbortSignal.timeout(30_000) });
    return res.ok ? await res.text() : null;
  } catch { return null; }
}

// Se la tabella non esiste ancora (migrazione non applicata) non c'è niente da fare.
const funds = (await rest("funds?select=isin,nav_url").catch((e) => { console.log(`Fondi non disponibili: ${(e as Error).message}`); return null; })) as
  { isin: string; nav_url: string | null }[] | null;
if (!funds?.length) { console.log("Nessun fondo da aggiornare."); process.exit(0); }
const found: (Nav | null)[] = [];
for (const f of funds) {
  const [fam, ft] = await Promise.all([f.nav_url ? page(f.nav_url) : null, page(ftUrl(f.isin))]);
  const a = fam ? parseFamNav(fam, f.isin) : null, b = ft ? parseFtNav(ft, f.isin) : null;
  console.log(`Fondo ${f.isin}: gestore ${a ? a.date : "n.d."}, FT ${b ? b.date : "n.d."}`);
  found.push(a, b);
}
const navs = mergeNavs(found);
const r = await rest("rpc/yrols_fund_sync", { method: "POST", body: JSON.stringify({ payload: { navs } }) });
console.log(`Fondi: ${funds.length}, NAV salvati ${r.navs}, rate PAC contate ${r.pac}`);
if (!navs.length) { console.log("::warning::Nessun NAV letto dalle fonti pubbliche"); }
