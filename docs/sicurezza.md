# Sicurezza dell'accesso online

- **Password + codice a 6 cifre (TOTP)**: dopo la password l'app chiede il codice dell'app di autenticazione.
  Al primo accesso la configurazione è guidata (QR o pulsante "Aggiungi all'app" sul telefono).
- **Regola nel database**: `yrols.yrols_is_member()` è vera solo per il proprietario con sessione `aal2`
  (password + codice). La usano tutte le regole RLS, i bucket `yrols-fatture` / `yrols-scontrini`, le funzioni
  del cruscotto e le Edge Function. Con la sola password non si legge né si scrive nulla.
  Le Action di GitHub usano `service_role` e non ne sono toccate.
- **Un solo proprietario**: niente "Crea account" nell'app; `yrols_claim()` assegna il proprietario solo a tabella
  `yrols_members` vuota e con il codice.
- **Dispositivo ricordato**: al login la casella "Ricorda questo dispositivo" (spuntata di serie) tiene la sessione
  aperta per 30 giorni dall'ultimo accesso completo; poi di nuovo password e codice. Si attiva o si toglie anche dalla
  pagina Sicurezza ("Questo dispositivo"). "Esci" e "Esci da tutti i dispositivi" lo dimenticano.
  La sessione è salvata con una chiave propria (`yrols-auth`, in `apps/web/src/cloud.ts`): le altre demo su
  `loriscuba.github.io` usano lo stesso progetto Supabase e la stessa origine, e con la chiave predefinita un loro
  login o logout sovrascriveva la sessione di Yrols. Attenzione: un'uscita "globale" (predefinita in supabase-js)
  da un'altra demo con lo stesso account chiude comunque anche le sessioni di Yrols.
- **Sblocco rapido** (facoltativo, solo su dispositivo ricordato): dopo 30 minuti di pausa l'app si blocca e si
  riapre con Face ID / Touch ID / impronta (WebAuthn del dispositivo). È un blocco dello schermo locale, non sostituisce
  password e codice: protegge da chi prende in mano il telefono già sbloccato.
- **Uscita automatica** dopo 30 minuti senza usare l'app sui dispositivi non ricordati. Regole in
  `apps/web/src/lockPolicy.ts` (`IDLE_MINUTES`, `TRUST_DAYS`), con test in `apps/server/test/lockPolicy.test.ts`.
- **Pagina Sicurezza**: dispositivi con il codice (consigliato averne due), cambio password, "Esci da tutti i dispositivi".
- **Protezioni della pagina**: Content-Security-Policy in `<meta>` (GitHub Pages non permette intestazioni HTTP):
  script solo dal sito, connessioni solo verso Supabase; la pagina non si apre dentro un iframe.

## Telefono perso

Se resta un secondo dispositivo, entra con quello, togli il telefono perso dalla pagina Sicurezza e premi
"Esci da tutti i dispositivi". Se non ne resta nessuno, il codice si azzera dal database (con conferma di Loris):

```sql
delete from auth.mfa_factors where user_id = (select user_id from yrols.yrols_members limit 1);
```

Al login successivo l'app chiede di configurare di nuovo il codice.

## Impostazioni del progetto Supabase (condiviso con altre demo)

Le impostazioni di Auth valgono per tutto il progetto "Demo IPA", quindi non sono cambiate da qui:
limiti ai tentativi di accesso e al codice sono quelli predefiniti di Supabase. La protezione da password
trapelate (HaveIBeenPwned) richiede il piano Pro. Le passkey di Supabase sono ancora sperimentali.
