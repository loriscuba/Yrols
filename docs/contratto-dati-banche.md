# Contratto dati Banche (v1)

Il cruscotto Yrols riceve i dati bancari dal connettore Enable Banking
(`connectors/enable-banking/`) con una chiamata HTTP di sincronizzazione
(**push**). Il connettore è l'unico che parla con Enable Banking; il cruscotto
salva i dati nel proprio database e li mostra anche quando il connettore è spento.

I tipi `Account`, `Balance`, `Transaction` sono gli stessi del formato normalizzato
del connettore.

## Endpoint di ingestione

```
POST /api/banks/sync
Authorization: Bearer <YROLS_INGEST_TOKEN>
Content-Type: application/json
```

`YROLS_INGEST_TOKEN` è una variabile d'ambiente del server del cruscotto (stesso
valore configurato nel connettore). Se non è impostata, l'endpoint risponde `503`.

Semantica: **upsert** per `id`. Una sync non cancella nulla. I saldi vengono
storicizzati (uno per conto, tipo e data), così il cruscotto può disegnare
l'andamento del patrimonio.

### Corpo

```json
{
  "source": "enablebanking",
  "syncedAt": "2026-11-01T15:00:00Z",
  "connections": [
    { "id": "session-uid", "bankName": "Intesa Sanpaolo", "country": "IT",
      "validUntil": "2027-01-30T00:00:00Z", "status": "active" }
  ],
  "accounts": [
    { "id": "account-uid", "iban": "IT60X0542811101000000123456",
      "name": "Conto corrente famiglia", "currency": "EUR",
      "bankName": "Intesa Sanpaolo", "connectionId": "session-uid" }
  ],
  "balances": [
    { "accountId": "account-uid", "amount": 2450.32, "currency": "EUR",
      "type": "CLBD", "date": "2026-11-01" }
  ],
  "transactions": [
    { "id": "entry-reference-o-hash", "accountId": "account-uid",
      "amount": -82.10, "currency": "EUR", "bookingDate": "2026-10-30",
      "valueDate": "2026-10-30", "description": "ADDEBITO SDD ENEL ENERGIA",
      "counterparty": "Enel Energia", "status": "BOOK" }
  ]
}
```

### Regole sui campi

| Campo | Obbligatorio | Note |
|---|---|---|
| `accounts[].id` | sì | `uid` del conto Enable Banking, stabile tra sync |
| `accounts[].name`, `bankName`, `iban`, `currency`, `connectionId` | no | |
| `balances[].accountId`, `amount` | sì | `amount` numero (non stringa), negativo = debito |
| `balances[].type` | no | codice ISO (`CLBD`, `ITAV`, `XPCD`…). Saldo mostrato: preferenza `ITAV` > `CLAV` > `XPCD` > `CLBD` > altri, poi data più recente |
| `balances[].date` | no | `YYYY-MM-DD`, default la data di `syncedAt` |
| `transactions[].id`, `accountId`, `amount`, `bookingDate` | sì | `amount` con segno: negativo = uscita, positivo = entrata |
| `transactions[].status` | no | `BOOK` (default) o `PDNG` |
| `connections[]` | no | `validUntil` serve a ricordare il rinnovo del consenso PSD2 |

Tutti gli array sono opzionali.

### Risposta

```json
{ "ok": true, "connections": 1, "accounts": 1, "balances": 1, "transactions": 1 }
```

Errori: `401` token errato, `400` payload non valido (`error` indica il campo),
`503` token non configurato sul server.

## Endpoint di lettura (usati dal frontend)

- `GET /api/banks/accounts` → conti con saldo corrente
- `GET /api/banks/transactions?accountId=&from=&to=&limit=` → movimenti
- `GET /api/banks/connections` → consensi con scadenza
- `GET /api/banks/history` → patrimonio totale per giorno

## Scadenza consenso

Una connessione con `validUntil` entro 14 giorni compare tra le scadenze in
arrivo nella Panoramica.
