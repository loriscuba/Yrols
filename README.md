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

## Struttura

```
apps/server   API Node (Express + node:sqlite)
apps/web      Interfaccia React + Vite
docs/         Contratto dati con il connettore bancario
```

## Collegare le banche (Enable Banking)

Il connettore in `connectors/enable-banking/` invia i dati al cruscotto con
`POST /api/banks/sync`, autenticato con `YROLS_INGEST_TOKEN` (lo stesso valore va
configurato nel connettore). Formato e regole: [docs/contratto-dati-banche.md](docs/contratto-dati-banche.md).

## Collegare la posta

Nel file `.env`:

```
YROLS_IMAP_HOST=imap.gmail.com
YROLS_IMAP_USER=tuo.indirizzo@gmail.com
YROLS_IMAP_PASSWORD=<password per le app>
YROLS_IMAP_INTERVAL_MIN=60
```

Con Gmail serve una [password per le app](https://myaccount.google.com/apppasswords)
(richiede la verifica in due passaggi). Il riconoscimento è pensato per i fornitori
italiani (Enel, Eni Plenitude, A2A, Hera, Iren, Acea, TIM, Vodafone, WindTre, Iliad,
Fastweb…) e per scadenze come bollo auto, RC auto, IMU, F24, documenti; le email
promozionali vengono ignorate. Si può lanciare una lettura a mano dalla pagina *Da email*.

## Test

```bash
npm test
```
