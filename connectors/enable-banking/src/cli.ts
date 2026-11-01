#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { buildService } from "./server.js";

const HELP = `Uso: npm run cli -- <comando> [argomenti]

  check                         verifica credenziali (GET /application)
  banks [PAESE]                 elenca le banche disponibili (default IT)
  connect "<Banca>" [PAESE]     avvia il consenso e stampa l'URL da aprire
  callback "<URL>"              completa il consenso incollando l'indirizzo su cui
                                la banca ti ha rimandato (anche se la pagina non si apre)
  connections                   elenca i consensi salvati e la scadenza
  accounts                      elenca i conti collegati
  balances <accountId>          saldi del conto
  transactions <accountId> [DA] [A]   movimenti (date YYYY-MM-DD)
  sync [file.json]              sincronizza tutto: push al cruscotto se configurato,
                                altrimenti salva il payload su file (o stdout)
  disconnect <connectionId>     revoca un consenso
`;

async function run(argv: string[]) {
  const [cmd, ...args] = argv;
  if (!cmd || cmd === "help" || cmd === "--help") {
    process.stdout.write(HELP);
    return;
  }
  const cfg = loadConfig();
  const svc = buildService(cfg);
  const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));

  switch (cmd) {
    case "check":
      return out(await svc.client.getApplication());
    case "banks":
      return out((await svc.listBanks(args[0] ?? "IT")).map((a) => ({ name: a.name, country: a.country, maxConsentDays: a.maximum_consent_validity ? Math.floor(a.maximum_consent_validity / 86400) : undefined })));
    case "connect": {
      if (!args[0]) throw new Error('Specifica la banca, es: connect "Intesa Sanpaolo" IT');
      const { url } = await svc.startConnection(args[0], args[1] ?? "IT");
      console.log(`Apri questo link e completa l'accesso alla banca:\n${url}\n`);
      console.log(`Al termine la banca ti rimanda su ${cfg.redirectUrl}.`);
      console.log(`Se il server del connettore non è attivo la pagina darà errore: copia l'indirizzo dalla barra del browser e lancia\n  npm run cli -- callback "<indirizzo>"`);
      return;
    }
    case "callback": {
      const u = new URL(required(args[0], "URL di ritorno"));
      const err = u.searchParams.get("error");
      if (err) throw new Error(`La banca ha rifiutato il consenso: ${u.searchParams.get("error_description") ?? err}`);
      const conn = await svc.completeConnection(u.searchParams.get("code") ?? "", u.searchParams.get("state") ?? "");
      console.log(`Banca collegata: ${conn.bankName}, ${conn.accounts.length} conti, consenso valido fino al ${conn.validUntil}`);
      return out(conn.accounts);
    }
    case "connections":
      return out(await svc.listConnections());
    case "accounts":
      return out(await svc.listAccounts());
    case "balances":
      return out(await svc.getBalances(required(args[0], "accountId")));
    case "transactions":
      return out(await svc.getTransactions(required(args[0], "accountId"), args[1], args[2]));
    case "sync": {
      const r = await svc.sync(cfg.push);
      console.error(`Conti: ${r.payload.accounts?.length}, saldi: ${r.payload.balances?.length}, movimenti: ${r.payload.transactions?.length}, errori: ${r.errors.length}`);
      for (const e of r.errors) console.error(` - ${e.step} ${e.accountId ?? ""}: ${e.message}`);
      if (r.pushed) return out(r.pushed);
      if (args[0]) await writeFile(args[0], JSON.stringify(r.payload, null, 2));
      else out(r.payload);
      return;
    }
    case "disconnect":
      await svc.disconnect(required(args[0], "connectionId"));
      return console.log("Consenso revocato");
    default:
      process.stdout.write(HELP);
      process.exitCode = 1;
  }
}

function required(v: string | undefined, name: string): string {
  if (!v) throw new Error(`Argomento mancante: ${name}`);
  return v;
}

run(process.argv.slice(2)).catch((e) => {
  console.error(`Errore: ${(e as Error).message}`);
  process.exitCode = 1;
});
