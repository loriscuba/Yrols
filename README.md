# Yrols

Cruscotto personale per il patrimonio familiare: **banche, bollette, scadenze e promemoria** in un'unica pagina.

| Sezione | Cosa fa |
|---|---|
| **Panoramica** | Patrimonio sui conti, entrate e uscite degli ultimi 30 giorni, tutto ciò che scade nei prossimi 30 giorni (bollette, scadenze, rinnovo consenso bancario), promemoria, grafici dell'andamento |
| **Banche** | Conti e saldi, movimenti con ricerca, scadenza dei consensi PSD2. I dati arrivano dal connettore Enable Banking |
| **Bollette** | Utenze di casa con scadenza, periodo, stato pagata/da pagare. Una bolletta viene segnata **pagata in automatico** quando in banca compare l'addebito corrispondente |
| **Scadenze** | Bollo, assicurazioni, tasse, documenti… con ricorrenza: completata una scadenza annuale, si ripropone da sola l'anno dopo |
| **Promemoria** | Lista di cose da fare con data e priorità |
| **Da email** | Legge la casella di posta (IMAP, anche Gmail), riconosce bollette e scadenze e te le propone: niente viene aggiunto senza la tua conferma |

## Avvio rapido

Serve Node.js **22.13 o successivo**.

```bash
npm install
cp .env.example .env      # imposta almeno YROLS_INGEST_TOKEN
npm run seed              # facoltativo: dati di esempio per provare
npm run dev               # web su http://localhost:5173, API su :3001
```

In produzione:

```bash
npm run build && npm start   # tutto su http://localhost:3001
```

I dati stanno in un file SQLite (`data/yrols.db`, configurabile con `YROLS_DB`). Per il backup basta copiare quel file.

> Il cruscotto contiene dati finanziari: se lo esponi oltre il tuo computer imposta `YROLS_USER` e `YROLS_PASSWORD` (accesso protetto) e mettilo dietro HTTPS.

## Versione online (GitHub Pages + Supabase)

Per usarlo anche a computer spento il cruscotto gira online, senza server:

- **Interfaccia** su GitHub Pages: `https://loriscuba.github.io/Yrols/`, con login.
- **Dati** nello schema `yrols` del progetto Supabase *Demo IPA* (`supabase/migrations/`). Il repository è pubblico,
  quindi nessun dato e nessuna chiave segreta stanno nel repo: l'accesso è protetto dalle regole
  del database (RLS) e solo il **primo account creato** diventa proprietario.
- **Banche**: una GitHub Action del connettore chiama `yrols.yrols_bank_sync` ogni 6 ore (header `Content-Profile: yrols`).
- **Email**: `.github/workflows/email.yml` legge la posta ogni ora. Gmail si collega dalla pagina *Da email*
  con l'accesso Google in sola lettura (vedi [Collegare la posta](#collegare-la-posta)).

Configurazione, una volta sola:

1. Applica la migrazione al progetto Supabase e aggiungi `yrols` agli *Exposed schemas* (Settings → Data API).
2. In Supabase → Authentication → URL Configuration imposta *Site URL* = `https://loriscuba.github.io/Yrols/`.
3. Su GitHub → Settings → Secrets and variables → Actions:
   - **Secrets**: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (e, solo per caselle non Gmail, `YROLS_IMAP_HOST`, `YROLS_IMAP_USER`, `YROLS_IMAP_PASSWORD`)
4. Settings → Pages → Source = *GitHub Actions*, poi lancia il workflow *Cruscotto su GitHub Pages*.
5. Inserisci il tuo utente in `yrols.yrols_members` (se la tabella è vuota, il primo account che
   accede diventa proprietario). Il progetto è condiviso con altre app: gli altri utenti possono
   fare login ma non vedono nessun dato di Yrols.

I log delle Actions di un repo pubblico sono pubblici: gli script stampano solo conteggi.

## Struttura

```
apps/server   API Node (Express + node:sqlite)
apps/web      Interfaccia React + Vite (server locale o Supabase)
supabase/     Schema del database online e relativi test
docs/         Contratto dati con il connettore bancario
```

## Collegare le banche (Enable Banking)

Il connettore in `connectors/enable-banking/` invia i dati al cruscotto con
`POST /api/banks/sync`, autenticato con `YROLS_INGEST_TOKEN` (lo stesso valore va
configurato nel connettore). Formato e regole: [docs/contratto-dati-banche.md](docs/contratto-dati-banche.md).

## Collegare la posta

### Online, con Gmail (consigliato)

Il collegamento usa **Google OAuth in sola lettura** (`gmail.readonly`): Yrols non conosce la
password, non può inviare né cancellare email, e l'accesso si revoca dalla pagina *Da email*
(pulsante *Scollega*) o da [myaccount.google.com/connections](https://myaccount.google.com/connections).

Come sono protette le chiavi:
- il *client secret* Google sta **solo** nei secret della Edge Function `yrols-email-auth` su Supabase;
- il *refresh token* sta in `yrols.email_accounts`, tabella senza policy (solo `service_role`), e da solo non
  serve a nulla senza il client secret;
- la GitHub Action chiede alla Edge Function un access token valido un'ora e nei log stampa solo conteggi.

Configurazione, una volta sola (dal browser):

1. [console.cloud.google.com](https://console.cloud.google.com) → nuovo progetto "Yrols".
2. *API e servizi → Libreria* → abilita **Gmail API**.
3. *Google Auth Platform* → *Branding*: nome app "Yrols", la tua email come supporto e contatto.
   *Audience*: tipo **Esterno**, poi **Pubblica app** (in "Test" Google fa scadere l'accesso ogni 7 giorni).
   *Data access*: aggiungi lo scope `https://www.googleapis.com/auth/gmail.readonly`.
4. *Clients* → *Crea client* → **Applicazione web**, URI di reindirizzamento autorizzato:
   `https://loriscuba.github.io/Yrols/callback/`. Copia ID client e client secret.
5. Supabase → *Edge Functions → Secrets*: `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET`.
6. Nel cruscotto, pagina *Da email* → **Collega Gmail**. Google mostrerà "app non verificata"
   (è la tua app personale): *Avanzate → Vai a Yrols*, lascia la spunta di lettura e conferma.

### Altri provider o server locale (IMAP)

Online: secret GitHub `YROLS_IMAP_HOST`, `YROLS_IMAP_USER`, `YROLS_IMAP_PASSWORD` (usati solo se
nessuna Gmail è collegata). In locale, nel file `.env`:

```
YROLS_IMAP_HOST=imap.gmail.com
YROLS_IMAP_USER=tuo.indirizzo@gmail.com
YROLS_IMAP_PASSWORD=<password per le app>
YROLS_IMAP_INTERVAL_MIN=60
```

Usa sempre una *password per le app* del provider, mai quella principale: con Gmail
[si crea qui](https://myaccount.google.com/apppasswords) (richiede la verifica in due passaggi).

Il riconoscimento è pensato per i fornitori
italiani (Enel, Eni Plenitude, A2A, Hera, Iren, Acea, TIM, Vodafone, WindTre, Iliad,
Fastweb…) e per scadenze come bollo auto, RC auto, IMU, F24, documenti; le email
promozionali vengono ignorate. In locale si può lanciare una lettura a mano dalla pagina *Da email*.

## Test

```bash
npm test
```
