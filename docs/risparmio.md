# Risparmio: controllo settimanale delle offerte

La pagina **Risparmio** del cruscotto mostra, per luce, gas, internet casa, telefonia mobile e abbonamenti,
le offerte più convenienti di quello che si paga oggi.

## Come funziona

- **Dati**: tabelle `yrols.saving_offers`, `yrols.saving_runs`, `yrols.saving_profile` (migrazione
  `20261114120000_yrols_risparmio.sql`). Si scrive con la RPC `yrols.yrols_save_offers(run jsonb)`.
- **Controllo settimanale**: un'attività pianificata di Claude (ogni lunedì mattina) legge spesa attuale e
  profilo di consumo da Supabase, cerca le offerte sul web e le salva con `yrols_save_offers`.
  Il Portale Offerte ARERA (`ilportaleofferte.it`) rifiuta le richieste dai server cloud (403 da GitHub Actions),
  quindi le fonti sono i comparatori pubblici e i siti dei fornitori; il Portale resta il riferimento da citare.
- **Confronto nella pagina**: `apps/server/src/savings.ts` (logica pura, testata). La spesa attuale si prende dal
  controllo, poi dall'anagrafica fornitori (`yrols.suppliers`), poi dai pagamenti ricorrenti.

Nessun dato personale è nel repository: consumi, spese e offerte stanno solo nel database.

## Istruzioni del controllo settimanale

Il testo qui sotto è il prompt dell'attività pianificata.

```text
Controllo settimanale "Risparmio" del cruscotto Yrols. Rispondi e scrivi tutto in italiano.
Database: progetto Supabase "Demo IPA" (ref exchjppslwhbnbzuhfqs), solo schema yrols. Non toccare altri schemi
e non modificare tabelle diverse da quelle indicate: le scritture passano SOLO da yrols.yrols_save_offers.

1. Leggi la situazione attuale (sola lettura):
   - select * from yrols.saving_profile;  (consumi annui kWh/Smc, potenza, provincia, linee mobili, note e preferenze)
   - l'anagrafica fornitori, se la tabella esiste: select name, kind, monthly, status from yrols.suppliers where status <> 'nascosto';
   - in ogni caso i pagamenti degli ultimi 4 mesi verso utenze e abbonamenti:
     select coalesce(counterparty, description) chi, date_trunc('month', booking_date)::date mese, count(*), sum(amount)
     from yrols.bank_transactions where amount < 0 and booking_date > current_date - 120 group by 1, 2 order by 1, 2;
     e le bollette: select provider, kind, amount, period_from, period_to, items from yrols.bills order by due_date desc limit 20;
   Ricava per ogni voce (luce, gas, internet, telefono, abbonamenti) fornitore attuale e spesa mensile media.
   Un fornitore di luce e gas con due addebiti al mese (es. Sorgenia) va diviso tra luce e gas: usa le bollette se ci sono,
   altrimenti la quota tipica (luce circa metà) e dillo nel riepilogo. Se mancano i consumi stimali dalla spesa
   (luce circa 0,30 €/kWh tutto compreso, gas circa 1,30 €/Smc) e dillo nel riepilogo.

2. Cerca le offerte in corso (usa la ricerca web e lo scraping di pagine pubbliche, senza aggirare blocchi):
   - luce e gas per casa: comparatori come luce-gas.it (Selectra), SOStariffe.it, Facile.it, e i siti dei fornitori;
   - internet casa (fibra FTTH/FTTC alla velocità minima del profilo) e telefonia mobile (giga e linee del profilo);
   - per gli abbonamenti, solo se esiste lo stesso servizio a meno (es. piano annuale).
   Calcola per ognuna la spesa mensile stimata PER I CONSUMI DEL PROFILO, IVA e oneri inclusi
   (per le variabili usa il PUN/PSV medio atteso indicato dai comparatori). Includi anche le promo a tempo,
   indicando in conditions quando finisce lo sconto e il costo dopo. Tieni le 3-5 migliori per voce,
   più l'offerta attuale del fornitore se la trovi. Scarta offerte solo per nuovi clienti di altri servizi,
   business, o con vincoli contrari alle note del profilo.

3. Salva tutto con UNA chiamata:
   select yrols.yrols_save_offers($json$ { "sources": ["..."], "summary": "...", "offers": [ ... ] } $json$::jsonb);
   Ogni offerta: {"category": "luce|gas|internet|telefono|abbonamenti", "provider", "name", "priceType": "fisso|variabile",
   "monthlyCost": numero, "currentMonthly": numero (spesa attuale di quella voce), "currentProvider",
   "priceDetails": "es. 0,115 €/kWh + 8 €/mese", "conditions": "vincoli, promo, costi di attivazione",
   "url": "https://... pagina dell'offerta", "source": "es. Selectra", "validUntil": "AAAA-MM-GG" o null}.
   summary: 1-3 frasi per Loris con il risparmio annuo migliore e cosa conviene fare (es. "Passando a X per la luce
   risparmi circa 120 € l'anno; internet: Fastweb è già tra i più economici").
   Non inventare prezzi: ogni offerta deve venire da una pagina letta in questo controllo, con il suo url.

4. Se trovi un risparmio di almeno 100 € l'anno su una voce, mettilo all'inizio del summary.
```
