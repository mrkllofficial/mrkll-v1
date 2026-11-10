# MRKLL — Database prenotazioni (Supabase)

| File | Contenuto |
|---|---|
| `migrations/20261110000000_booking_system.sql` | Schema completo: tabelle, vincoli anti-sovrapposizione, funzioni, sicurezza |
| `migrations/20261111000000_closed_days.sql` | I giorni interamente chiusi (festivi, chiusure) risultano `closed` invece di "pieni" |
| `migrations/20261112000000_webhook.sql` | Webhook Stripe: registro eventi, rimborsi (anche fuori ordine), email inviate una sola volta |
| `seed.sql` | Dati iniziali: impostazioni, orari di apertura, pacchetti, orari d'inizio (ri-eseguibile) |
| `holidays.sql` | Festività nazionali, catalane e locali di Barcellona fino a fine 2027, con fonti ufficiali (ri-eseguibile) |
| `cron.sql` | Job pianificati `pg_cron`: rilascio blocchi scaduti (ogni 5 min) e pulizia GDPR (giornaliera) |
| `verify.sql` | Verifica finale in **sola lettura**: 20 controlli (schema, RLS, permessi, dati, cron) |
| `status.sql` | Stato dell'installazione in **sola lettura** (quali passi sono applicati, sicurezza), da usare in qualsiasi momento dopo la migrazione 1 |
| `tests/` | Test automatici, eseguiti in locale con `npm test` (non toccano Supabase) |

## Inizializzare lo STAGING (`mrkll-staging`)

> Non incollare mai password o chiavi in chat, nel codice o in file del repository.
> Ogni file SQL è una transazione unica: se si ferma con un errore **non cambia nulla**.
> I file si rifiutano di partire nell'ordine sbagliato o se sono già stati applicati.
> Prova generale locale della procedura: `npm run test:staging`.
> I file non usano blocchi `DO` né vincoli `EXCLUDE` scritti direttamente: il SQL Editor di Supabase
> controlla le query con un parser che li rifiuta ("Expected: an SQL statement, found: do"). I
> controlli girano in funzioni temporanee `pg_temp` (esistono solo nella sessione).

1. **Controlli preliminari** (SQL Editor → New query): `select version();` deve indicare PostgreSQL
   **15 o superiore** (i nuovi progetti usano la 17).
2. **Abilita pg_cron:** Dashboard → **Integrations → Cron** → *Enable* (in alcune versioni della
   dashboard: **Database → Extensions** → `pg_cron` → *Enable*). Nessun'altra estensione è necessaria.
3. **Esegui nel SQL Editor**, un file alla volta, in una *nuova query* ciascuno (copia tutto il
   contenuto del file → *Run*), in questo ordine:
   1. `migrations/20261110000000_booking_system.sql`
   2. `migrations/20261111000000_closed_days.sql`
   3. `migrations/20261112000000_webhook.sql`
   4. `seed.sql` — la dashboard può avvisare di un'operazione "distruttiva" (`delete` sulle tabelle
      di configurazione appena create e vuote): conferma.
   5. `holidays.sql`
   6. `cron.sql`
   In qualsiasi momento dopo il file 1 puoi eseguire `status.sql` (sola lettura) per vedere a che
   punto sei e che la sicurezza sia intatta.
4. **Verifica:** esegui `verify.sql` (sola lettura). Tutte le 20 righe devono essere `OK` e
   l'ultima `ALL OK`.
5. **Security Advisor** (Dashboard → Advisors): è atteso solo "RLS Enabled No Policy" (INFO) sulle
   tabelle MRKLL — è voluto: nessuno può leggere o scrivere dal browser.
6. **Chiavi per Vercel** (Project Settings → API Keys): *Project URL* (`https://<ref>.supabase.co`)
   e una **Secret key** (`sb_secret_…`). **Non copiarle in chat.** Inseriscile tu su Vercel, solo
   nell'ambiente *Preview*, come `SUPABASE_URL` e `SUPABASE_SECRET_KEY` (Sensitive). La chiave
   *publishable* non serve e il backend la rifiuta.

Se una chiamata API risponde "function not found" subito dopo la migrazione, ricarica lo schema
dell'API con `notify pgrst, 'reload schema';`.

## Gestione dallo studio (Table Editor / SQL Editor)

- **Prenotazioni:** vista `bookings_calendar` (orari in ora di Barcellona).
- **Prenotazione manuale** (telefono, cliente in studio): bastano pacchetto e inizio, il resto è calcolato.
  ```sql
  insert into public.bookings (package_id, starts_at, status, source, customer_name, admin_notes)
  values ('pro', '2026-12-03 10:00 Europe/Madrid', 'confirmed', 'admin', 'Nome cliente', 'nota');
  ```
- **Chiusura** (ferie, festivi, manutenzione):
  ```sql
  insert into public.blackout_periods (period, reason)
  values (tstzrange('2026-12-24 00:00 Europe/Madrid', '2026-12-27 00:00 Europe/Madrid'), 'Natale');
  ```
- **Festività dell'anno successivo:** aggiungi le nuove date in `holidays.sql` quando escono l'ordine
  catalano (di solito in primavera) e il decreto del Comune di Barcellona (di solito a giugno), poi
  rieseguilo: le date già presenti non vengono duplicate.
- **Email inviate:** tabella `email_notifications` (`sent`, `failed` = verrà ritentata da Stripe,
  `abandoned` = errore definitivo, ad es. indirizzo non valido).
- **Rimborsi:** fai il rimborso dalla dashboard Stripe. Con rimborso totale il webhook segna la
  prenotazione `refunded`, libera lo slot e avvisa cliente e studio; un rimborso parziale non cambia
  la prenotazione.
- **Annullare** una prenotazione: imposta `status = 'cancelled'` (lo slot torna libero subito).
  Il rimborso si fa dalla dashboard Stripe.

Il vincolo `bookings_no_overlap` impedisce qualsiasi sovrapposizione anche agli inserimenti manuali.
