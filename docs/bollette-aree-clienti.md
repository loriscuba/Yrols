# Bollette dalle aree clienti dei fornitori

Un'attività programmata di **Claude desktop**, su un PC di casa sempre acceso, apre le aree clienti dei
fornitori in Chrome (con gli accessi già fatti dall'utente), scarica le fatture nuove e le manda a Yrols.
Claude non conosce né salva le password dei fornitori.

```
Chrome sul PC (MyFastweb, MySorgenia)
   └─ PDF ─► Edge Function yrols-inbox (chiave personale) ─► bucket yrols-fatture/portale/<hash>.pdf
                                                           └► coda yrols.portal_files
GitHub Actions "Lettura email" (ogni ora) ─► legge il PDF ─► bollette (source "portale") o proposta in "Da email"
```

## Lato Yrols (una volta)

1. Migrazione `supabase/migrations/20261116150000_yrols_portale.sql`.
2. Edge Function `yrols-inbox` con **verify_jwt disattivato** (l'accesso lo controlla la chiave).
3. Secret della funzione `YROLS_INBOX_KEY`: una stringa casuale di almeno 32 caratteri.
   La stessa chiave va solo nell'attività programmata sul PC. **Mai nel repository** (è pubblico).

La casella accetta solo PDF fino a 10 MB; lo stesso PDF inviato due volte entra una volta sola, e
`yrols_save_invoice` evita i doppioni anche con le bollette arrivate per email o caricate a mano.

## Invio di un PDF

```
POST https://<progetto>.supabase.co/functions/v1/yrols-inbox?provider=Fastweb&filename=fattura.pdf
x-yrols-key: <chiave>
Content-Type: application/pdf

<byte del PDF>
```

oppure JSON `{ "pdfBase64": "...", "provider": "Fastweb", "filename": "fattura.pdf" }`.
Risposta `{ "ok": true, "duplicate": false }`.

## Lato PC (Windows)

1. Claude desktop con l'accesso fatto, Chrome con l'estensione **Claude in Chrome**.
2. In Chrome, accesso una volta a MyFastweb e MySorgenia, con "ricordami".
3. Impostazioni di Windows: il PC non va in sospensione.
4. In Claude desktop, un'attività programmata settimanale che, per ogni fornitore, apre la pagina delle
   fatture, prende le fatture degli ultimi 60 giorni e le invia alla casella. Se una pagina chiede di nuovo
   l'accesso, l'attività si ferma e lo segnala senza inserire password.
