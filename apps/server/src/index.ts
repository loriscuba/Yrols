import { fileURLToPath } from "node:url";
import { openDb } from "./db.ts";
import { createApp } from "./app.ts";
import { imapConfigFromEnv, scanMailbox } from "./email.ts";

const env = process.env;
const db = openDb(env.YROLS_DB ?? fileURLToPath(new URL("../../../data/yrols.db", import.meta.url)));
const imap = imapConfigFromEnv();
const app = createApp(db, {
  ingestToken: env.YROLS_INGEST_TOKEN || undefined,
  basicAuth: env.YROLS_USER && env.YROLS_PASSWORD ? { user: env.YROLS_USER, password: env.YROLS_PASSWORD } : undefined,
  imap,
  webDist: fileURLToPath(new URL("../../web/dist", import.meta.url)),
});

const port = Number(env.PORT) || 3001;
app.listen(port, () => {
  console.log(`Yrols in ascolto su http://localhost:${port}`);
  if (!env.YROLS_INGEST_TOKEN) console.warn("YROLS_INGEST_TOKEN non impostato: la sync dal connettore bancario è disattivata.");
  if (!env.YROLS_USER) console.warn("Nessuna password impostata (YROLS_USER/YROLS_PASSWORD): non esporre il cruscotto in rete.");
});

const every = Number(env.YROLS_IMAP_INTERVAL_MIN);
if (imap && every > 0) {
  const run = () => scanMailbox(db, imap).then(
    (r) => r.found && console.log(`Email: ${r.found} nuove bollette/scadenze da confermare`),
    (e) => console.error("Scansione email non riuscita:", e.message));
  setTimeout(run, 5_000);
  setInterval(run, every * 60_000);
}
