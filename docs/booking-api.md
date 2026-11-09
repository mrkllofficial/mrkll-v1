# MRKLL — API di prenotazione

Tutte le API girano come Vercel Functions in `api/`. Il browser non comunica mai con Supabase.
Le chiavi restano solo lato server.

| Endpoint | Metodo | Scopo |
|---|---|---|
| `/api/availability?package=pro&month=2026-12` | GET | Calendario reale del mese: stato dei giorni e orari della griglia (ora di Barcellona) |
| `/api/create-checkout-session` | POST | Blocca lo slot (35 min) e crea la sessione Stripe Checkout (30 min) |
| `/api/release-hold` | POST | Rilascia lo slot bloccato da questo browser (annullamento / cambio orario) |
| `/api/stripe-webhook` | POST | Webhook Stripe (conferma e email) — aggiornamento previsto al passo 2.4 |

## `POST /api/create-checkout-session`

```json
{ "packageId": "pro", "date": "2026-12-03", "startTime": "10:00" }
```

Risposta `200`:

```json
{ "url": "https://checkout.stripe.com/...", "bookingId": "uuid", "releaseToken": "43 caratteri",
  "reference": "MRK-1A2B3C4D", "holdExpiresAt": "2026-11-09T10:35:00.000Z" }
```

`bookingId` e `releaseToken` vanno conservati in `sessionStorage` dal checkout (passo 2.5):
servono per rilasciare lo slot se il cliente annulla o sceglie un altro orario.

Errori: `400 INVALID_INPUT`, `403 ORIGIN_NOT_ALLOWED`, `404 PACKAGE_NOT_FOUND`,
`409 SLOT_UNAVAILABLE` (appena preso), `409 SLOT_NOT_BOOKABLE` (fuori griglia, orario, preavviso,
orizzonte), `415`, `429 TOO_MANY_HOLDS`, `502 PAYMENT_PROVIDER_ERROR` (lo slot viene liberato
subito), `503 SERVICE_UNAVAILABLE`.

## `POST /api/release-hold`

```json
{ "bookingId": "uuid", "releaseToken": "token ricevuto dal checkout" }
```

Risponde sempre `200 { "released": true | false }` (nessun dettaglio sul perché). La sessione Stripe
viene fatta scadere **prima** di liberare lo slot; una sessione già pagata non viene mai rilasciata.

## Rilascio automatico degli slot non pagati

1. Annullamento su Stripe → ritorno al checkout → `release-hold` (immediato).
2. Pagamento abbandonato → la sessione Stripe scade dopo 30 min; il blocco scade a 35 min e lo slot
   torna libero automaticamente (alla prenotazione successiva e con il job `pg_cron` ogni 5 min).
3. Dal passo 2.4: anche il webhook `checkout.session.expired` libera lo slot.

## Variabili d'ambiente (Vercel → Settings → Environment Variables)

Inserirle solo dalla dashboard Vercel, mai nel codice o in chat. Per ora solo nell'ambiente **Preview**.

| Variabile | Contenuto |
|---|---|
| `SUPABASE_URL` | Project URL del progetto Supabase di staging |
| `SUPABASE_SECRET_KEY` | Secret key Supabase (`sb_secret_…`) — *Sensitive* |
| `STRIPE_SECRET_KEY` | Chiave Stripe **test** (`sk_test_…` o `rk_test_…`) — *Sensitive* |
| `STRIPE_WEBHOOK_SECRET` | Segreto del webhook (`whsec_…`) — *Sensitive* |
| `BREVO_API_KEY` | Chiave Brevo — *Sensitive* |
| `SITE_URL` | URL pubblico del sito per quell'ambiente (https) |
| `BOOKING_IP_SALT` | Stringa casuale di almeno 32 caratteri — *Sensitive* |

Blocco di sicurezza: una chiave Stripe **live** viene rifiutata finché non si imposta anche
`STRIPE_LIVE_MODE=enabled` (da fare solo al go-live, con approvazione).

## Test

```bash
npm test
```

Esegue test unitari (con tre fusi orari diversi del server), test SQL e test di integrazione su un
PostgreSQL locale temporaneo. Nessuna chiamata a Supabase o Stripe reali.
