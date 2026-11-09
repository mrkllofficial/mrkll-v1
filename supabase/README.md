# MRKLL — Database prenotazioni (Supabase)

| File | Contenuto |
|---|---|
| `migrations/20261110000000_booking_system.sql` | Schema completo: tabelle, vincoli anti-sovrapposizione, funzioni, sicurezza |
| `seed.sql` | Dati iniziali: impostazioni, orari di apertura, pacchetti, orari d'inizio (ri-eseguibile) |
| `cron.sql` | Job pianificati `pg_cron`: rilascio blocchi scaduti (ogni 5 min) e pulizia GDPR (giornaliera) |
| `tests/` | Test automatici, eseguiti in locale con `bash scripts/db-test.sh` (non toccano Supabase) |

## Creare il progetto di STAGING

> Non incollare mai password o chiavi in chat, nel codice o in file del repository.

1. Su <https://supabase.com/dashboard> → **New project**.
   - **Name:** `mrkll-staging`
   - **Database password:** usa *Generate a password* e salvala solo nel tuo password manager.
   - **Region:** Central EU (Frankfurt) oppure West EU (Paris).
   - **Plan:** Free va bene per lo staging (il progetto va in pausa dopo ~7 giorni senza attività; si riattiva dalla dashboard).
   - **Security options:** lascia attivi *Data API* e lo schema `public` (servono alle funzioni Vercel).
2. Attendi il provisioning (1–2 minuti).
3. **Database → Extensions** → cerca `pg_cron` → **Enable**.
4. **SQL Editor → New query**, esegui nell'ordine (incolla il contenuto e premi *Run*):
   1. `migrations/20261110000000_booking_system.sql`
   2. `seed.sql`
   3. `cron.sql`
5. Verifica (nel SQL Editor):
   ```sql
   select * from public.get_availability('pro', current_date, current_date + 13);
   select jobname, schedule from cron.job;
   ```
   Devi vedere 14 giorni (domeniche `closed`, giorni entro 24 h `unavailable`, gli altri `available`) e 2 job.
6. **Project Settings → API Keys**: individua *Project URL* e la *Secret key* (`sb_secret_…`).
   **Non copiarle in chat.** Le inserirai tu direttamente su Vercel (solo ambiente *Preview*) al passo 2.2.

Il *Security Advisor* di Supabase segnalerà "RLS enabled, no policy": è voluto. Nessuno può leggere
o scrivere dal browser; l'accesso avviene solo dalle funzioni Vercel con la chiave segreta.

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
- **Annullare** una prenotazione: imposta `status = 'cancelled'` (lo slot torna libero subito).
  Il rimborso si fa dalla dashboard Stripe.

Il vincolo `bookings_no_overlap` impedisce qualsiasi sovrapposizione anche agli inserimenti manuali.
