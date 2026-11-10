# Migrazioni Supabase STAGING con GitHub Actions

Esegue **un solo file SQL del repository** sul progetto `mrkll-staging`, solo dopo la tua
approvazione, con `psql -v ON_ERROR_STOP=1`, e poi un controllo **in sola lettura**.
Nessuna password passa mai dalla chat, dal codice o dai log.

## Come funziona

```
push sul branch claude/elegant-hawking-oukftc che modifica supabase/deploy/staging-request.json
        │
        ▼
job "validate"  (nessun segreto, nessun accesso al database)
  · richiesta: target "staging", un solo file, percorso consentito, nessun SQL scritto nella richiesta
  · file: SHA-256 atteso, niente comandi psql (\! \i …), una sola transazione BEGIN … COMMIT
  · ambiente "supabase-staging": deve già avere un revisore obbligatorio e il vincolo sul branch
        │  (se manca qualcosa: si ferma, il job "apply" non parte)
        ▼
job "apply"  → GitHub lo mette IN ATTESA della tua approvazione
  · dopo "Approve": ricontrolla lo SHA-256, verifica che i dati di connessione descrivano un
    progetto Supabase coerente (ref / utente / host), esegue il file, poi status.sql (o verify.sql)
    in una sessione che rifiuta qualsiasi scrittura
  · riepilogo del job: file, commit, SHA-256, esito, risultato del controllo
```

File coinvolti:

| File | Ruolo |
|---|---|
| `.github/workflows/supabase-staging-migration.yml` | Il workflow (solo questo branch, solo il file di richiesta) |
| `scripts/migrations/validate-request.js` | Validazione della richiesta e del file, controllo dell'ambiente protetto |
| `scripts/migrations/sql-lint.js` | Regole sui file SQL (condivise con i test) |
| `scripts/migrations/apply.sh` | Esecuzione con `psql`, controllo "solo staging", log ripuliti |
| `supabase/deploy/staging-request.example.json` | Modello di richiesta (non avvia nulla) |
| `scripts/test-migration-runner.sh` | Test locale dell'esecuzione (`npm run test:migrations`) |

Perché un `push` e non il pulsante "Run workflow": GitHub mostra il pulsante (`workflow_dispatch`)
solo per i workflow presenti sul branch principale, che non deve essere modificato. Un `push` sul
branch di lavoro che modifica il file di richiesta funziona senza toccare `master`; ogni altro push
non avvia nulla.

## Configurazione una tantum (la fai tu, su GitHub)

Repository → **Settings → Environments → New environment** → nome esatto **`supabase-staging`**.

1. **Deployment protection rules**
   - ✅ **Required reviewers** → aggiungi il tuo account (`mrkllofficial`).
   - ⬜ **Prevent self-review**: lascialo **disattivato** (sei l'unico revisore).
   - Facoltativo: *Wait timer* (es. 1 minuto) come ulteriore margine.
2. **Deployment branches and tags** → **Selected branches and tags** → *Add deployment branch
   rule* → `claude/elegant-hawking-oukftc` (tipo *Branch*).
3. **Environment variables** (non segrete, visibili a chi gestisce il repository):

   | Nome | Valore |
   |---|---|
   | `STAGING_PROJECT_REF` | il *Reference ID* del progetto (Project Settings → General), 20 lettere |
   | `STAGING_DB_HOST` | host del **Session pooler** (Dashboard → Connect → *Session pooler*), es. `aws-1-eu-central-1.pooler.supabase.com` |
   | `STAGING_DB_PORT` | `5432` |
   | `STAGING_DB_NAME` | `postgres` |
   | `STAGING_DB_USER` | `postgres.<STAGING_PROJECT_REF>` (come nella stringa del Session pooler) |
   | `STAGING_DB_SSLMODE` | facoltativa; vuota = `require` (cifratura obbligatoria) |

4. **Environment secrets** → `STAGING_DB_PASSWORD` = la password del database del progetto
   staging. È l'unico segreto. Non va scritta altrove.

5. Repository → **Settings → Actions → General**
   - *Actions permissions*: il workflow non usa action esterne; puoi scegliere "Allow
     mrkllofficial actions and reusable workflows" senza aggiungerne altre.
   - *Workflow permissions*: **Read repository contents** (il workflow chiede comunque solo
     lettura).

Dopo la configurazione nessuna esecuzione parte da sola: serve una richiesta (sotto) **e** la tua
approvazione.

## Eseguire una migrazione

1. Claude (o tu) crea/aggiorna `supabase/deploy/staging-request.json` sul branch, ad esempio:
   ```json
   {
     "version": 1,
     "target": "staging",
     "file": "supabase/migrations/20261111000000_closed_days.sql",
     "sha256": "a7ae829fecdc787c2f4f7f6bf877aafd28d5da28d1fa2946f7060dd7648b9e49",
     "request_id": "staging-2026-11-10-m2",
     "reason": "Apply migration 2 (closed days) to staging",
     "post_check": "status"
   }
   ```
   e la pubblica con un commit (un solo file per richiesta; `request_id` nuovo ogni volta).
2. GitHub → **Actions** → "Supabase staging migration": il job *validate* deve essere verde;
   il job *apply* resta **Waiting**.
3. Controlla nel riepilogo file, SHA-256 e commit → **Review deployments** → seleziona
   `supabase-staging` → **Approve and deploy**. (Per annullare: *Reject*.)
4. Il risultato e l'output di `status.sql` compaiono nel riepilogo del job.

Esiti: `applied` + controllo `OK` · `SQL error` (transazione annullata, database invariato) ·
`connection failed` (variabili o password dell'ambiente) · controllo con problemi (il job fallisce
anche se il file è stato applicato: va guardato l'output del controllo).

## Migrazioni future

- File ammessi: `supabase/migrations/<14 cifre>_<nome>.sql`, `supabase/seed.sql`,
  `supabase/holidays.sql`, `supabase/cron.sql`. Ogni file deve essere una sola transazione
  (`begin; … commit;`), senza comandi psql e senza blocchi `DO` (vedi `npm test`).
- Impronta da mettere nella richiesta: `sha256sum <file>` sul commit da eseguire.
- Controllo dopo l'esecuzione: `"post_check": "status"` (avanzamento) oppure `"verify"` (verifica
  completa a fine installazione).
- Per un altro branch di lavoro: aggiungerlo sia al trigger del workflow sia alle *deployment
  branches* dell'ambiente.
- Produzione: **non** usa questo workflow. Andrà creato un ambiente separato
  (`supabase-production`) con le sue regole, quando servirà.

## Sicurezza

- La password esiste solo come segreto dell'ambiente `supabase-staging`, disponibile solo al job
  *apply*, solo dopo l'approvazione e solo da questo branch.
- Non viene mai costruita una stringa di connessione: `psql` riceve i dati tramite le variabili
  standard di PostgreSQL (`PGHOST`, `PGUSER`, `PGPASSWORD`, …).
- Host, utente e ref sono mascherati nei log; i messaggi di `psql` sono ripuliti da host, utente,
  ref e indirizzi IP.
- Non si può eseguire SQL arbitrario: solo file del repository al commit del push, con impronta
  verificata e regole sul contenuto.
- ⚠️ Il repository è **pubblico**: anche i log delle Actions sono pubblici. Non contengono dati
  sensibili, ma mostrano l'output di `status.sql` (nomi dei passi, conteggi). Valuta di rendere il
  repository privato (in quel caso gli ambienti protetti richiedono un piano GitHub a pagamento per
  gli account personali).
- Dopo l'installazione dello staging puoi eliminare il segreto o cambiare la password del database.

## Test locali (nessun accesso a Supabase)

```bash
npm run test:migrations
```

Esegue `apply.sh` su un PostgreSQL locale configurato come Supabase (password SCRAM, utente
`postgres.<ref>`, host del pooler simulato, migrazione 1 del commit `199b81c` già applicata):
applicazione, ripetizione, password errata, errore SQL con rollback, 12 rifiuti prima della
connessione, mascheramento, controllo in sola lettura, assenza di dati sensibili nei log.
