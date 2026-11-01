# Connettore Enable Banking per Yrols

Collega i conti bancari al cruscotto Yrols tramite [Enable Banking](https://enablebanking.com)
(open banking PSD2). Legge **conti, saldi e movimenti**, li converte nel formato
normalizzato del cruscotto e li invia a `POST {YROLS_URL}/api/banks/sync`.

- Node.js 20.6+ (testato con Node 22), TypeScript, **nessuna dipendenza runtime**.
- Accesso in sola lettura (AIS): il connettore non può disporre pagamenti.
- Il connettore è l'unico componente che parla con Enable Banking. Il cruscotto
  conserva i dati e li mostra anche a connettore spento.

## 1. Credenziali Enable Banking (da fare una volta)

1. Registrati su <https://enablebanking.com/cp/> (Control Panel).
2. Crea un'applicazione (*Applications → Register new application*):
   - ambiente **Sandbox** per le prove con banche finte, **Production** per i tuoi conti reali
     (per uso personale l'app di produzione si attiva collegando i propri conti, senza contratto commerciale);
   - **Redirect URL**: `https://localhost:8787/api/banks/callback`
     (Enable Banking accetta solo indirizzi **https**; vedi il punto 3 per come gestirlo in locale);
   - lascia che il pannello generi la coppia di chiavi: scarica il file `.pem` della **chiave privata**.
3. Annota l'**Application ID** (è il `kid` del JWT).
4. Metti la chiave in `connectors/enable-banking/keys/enable-banking.pem`
   (la cartella `keys/` è esclusa da git; non committare mai la chiave).

## 2. Configurazione

```bash
cd connectors/enable-banking
cp .env.example .env      # poi compila i valori
npm install
npm run build
npm run cli -- check      # verifica che app id e chiave funzionino
```

| Variabile | Obbligatoria | Descrizione |
|---|---|---|
| `ENABLE_BANKING_APP_ID` | sì | Application ID |
| `ENABLE_BANKING_PRIVATE_KEY_PATH` | sì* | Percorso del `.pem` (*oppure `ENABLE_BANKING_PRIVATE_KEY` inline) |
| `ENABLE_BANKING_REDIRECT_URL` | sì | Deve coincidere con quella registrata e puntare a `/api/banks/callback` |
| `ENABLE_BANKING_CONSENT_DAYS` | no | Durata consenso richiesto (default 90; molte banche accettano fino a 180) |
| `INITIAL_HISTORY_DAYS` | no | Storico movimenti alla prima sync (default 90) |
| `YROLS_URL` / `YROLS_INGEST_TOKEN` | no | Abilitano il push verso il cruscotto (token = `YROLS_INGEST_TOKEN` del server Yrols) |
| `SYNC_INTERVAL_MINUTES` | no | Sync automatica (default 360 = 4 al giorno, il limite PSD2 di accessi non presidiati per conto); 0 la disattiva |
| `CONNECTOR_API_TOKEN` | consigliata | Token Bearer richiesto dalle API del connettore. Senza, il server ascolta solo su 127.0.0.1 |
| `HOST`, `PORT` | no | Default `127.0.0.1:8787` |
| `TLS_CERT_PATH`, `TLS_KEY_PATH` | no | Se impostati il server parla https (`npm run cert` li genera) |
| `DATA_FILE` | no | Dove salvare le sessioni (default `./data/enable-banking.json`) |
| `CORS_ORIGIN`, `DASHBOARD_URL` | no | Origine del cruscotto e pagina su cui tornare dopo il consenso |

## 3. Collegare una banca

```bash
npm start                                   # opzionale: server del connettore (vedi sotto)
npm run cli -- banks IT                     # nome esatto della banca
npm run cli -- connect "Intesa Sanpaolo" IT # stampa il link per il consenso
```

Apri il link e autenticati sulla banca: la banca ti rimanda sulla Redirect URL
(`https://localhost:8787/api/banks/callback?code=...&state=...`). Due modi per completare:

- **Senza certificato (il più semplice)**: il browser mostrerà un errore di connessione,
  è normale. Copia l'indirizzo completo dalla barra del browser e lancia
  `npm run cli -- callback "<indirizzo copiato>"`. Il consenso è valido per 1 ora dall'avvio.
- **Con il server in https**: `npm run cert` genera un certificato per localhost in `keys/`
  (serve openssl, oppure usa [mkcert](https://github.com/FiloSottile/mkcert) per evitare
  l'avviso del browser), imposta `TLS_CERT_PATH`/`TLS_KEY_PATH` e avvia `npm start`.
  Il callback salva la sessione, lancia la prima sincronizzazione e ti riporta al
  cruscotto (`DASHBOARD_URL?bank=connected`). Così funziona anche il pulsante
  "Collega banca" del cruscotto.

Il consenso PSD2 scade (`validUntil`): il cruscotto lo mostra tra le scadenze
14 giorni prima. Per rinnovarlo basta ripetere `connect`.

## 4. API HTTP

Tutte le rotte (tranne `/health` e `/api/banks/callback`) richiedono
`Authorization: Bearer <CONNECTOR_API_TOKEN>` se il token è impostato.

| Metodo e percorso | Risposta |
|---|---|
| `GET /health` | `{ ok: true }` |
| `GET /api/banks/aspsps?country=IT` | banche disponibili |
| `POST /api/banks/connect` `{ bankName, country }` | `{ url }` da aprire nel browser |
| `GET /api/banks/callback?code&state` | ritorno dalla banca (redirect al cruscotto) |
| `GET /api/banks/connections` | `{ connections: Connection[] }` |
| `DELETE /api/banks/connections/:id` | revoca il consenso |
| `GET /api/banks/accounts` | `{ accounts: Account[] }` |
| `GET /api/banks/accounts/:id/balances` | `{ balances: Balance[] }` (lettura in tempo reale) |
| `GET /api/banks/accounts/:id/transactions?from&to` | `{ transactions: Transaction[] }` |
| `POST /api/banks/sync` `{ from? }` | sincronizza e invia al cruscotto; senza push configurato restituisce il `payload` |

Le letture in tempo reale consumano gli accessi PSD2 giornalieri: per il cruscotto
conviene leggere dal database di Yrols, alimentato dalla sync.

## 5. Formato dati

Definito in `src/types.ts` e nel contratto condiviso con il cruscotto
(`contratto-dati-banche.md`):

- `Account { id, iban?, name?, currency?, bankName?, connectionId? }`
- `Balance { accountId, amount, currency, type, date }` — `amount` numerico, negativo = debito
- `Transaction { id, accountId, amount, currency, bookingDate, valueDate?, description, counterparty?, status }`
  — `amount` negativo = uscita; `id` = `entry_reference`/`transaction_id` della banca,
  oppure un hash stabile se la banca non lo fornisce
- `Connection { id, bankName, country, validUntil, status }`

Saldo da mostrare: preferenza `ITAV` > `CLAV` > `XPCD` > `CLBD` (`pickPrimaryBalance`).

La sync è **incrementale**: la prima volta scarica `INITIAL_HISTORY_DAYS` giorni,
poi riparte da 7 giorni prima dell'ultima sync (per i movimenti contabilizzati in
ritardo); il cruscotto fa upsert per `id`, quindi i duplicati non sono un problema.

## 6. Uso come libreria

```ts
import { EnableBankingClient, BankingService, FileStore } from "@yrols/enable-banking-connector";

const client = new EnableBankingClient({ applicationId, privateKey });
const service = new BankingService({ client, store: new FileStore("./data/eb.json"), redirectUrl });
const { payload, errors } = await service.buildSyncPayload();
```

## Sicurezza

- La chiave privata e il file `data/` restano sul tuo computer (esclusi da git, file dati con permessi 600).
- Il file dati contiene solo id di sessione e anagrafica conti, nessuna password bancaria:
  l'autenticazione avviene sempre sul sito della banca.
- Se esponi il connettore fuori da localhost, imposta `CONNECTOR_API_TOKEN` e usa HTTPS.

## Sviluppo

```bash
npm test   # compila e lancia i test (API Enable Banking simulata)
```
