#!/usr/bin/env bash
# Dress rehearsal of the Supabase STAGING setup (supabase/README.md) on a
# throw-away local PostgreSQL with pg_cron, Supabase roles and default
# privileges (pg_cron connects through the local socket here; on Supabase
# it is preconfigured). Runs the files in the documented order, checks that wrong
# orders and re-runs are refused safely, that cron jobs really run, and
# that supabase/verify.sql reports ALL OK. Never touches Supabase.
#
#   bash scripts/staging-rehearsal.sh
#   REHEARSAL_M1_FROM=199b81c bash scripts/staging-rehearsal.sh
#       -> migration 1 taken from that commit (a project where an earlier
#          version of migration 1 is already applied), the rest from HEAD.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
WORK="$(mktemp -d)"
PORT="${PGPORT_REHEARSAL:-54331}"
RUN_AS=()
if [ "$(id -u)" = "0" ]; then chown postgres "$WORK"; RUN_AS=(runuser -u postgres --); fi
cleanup() { "${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

if [ ! -f "$("$PGBIN/pg_config" --sharedir 2>/dev/null || echo /usr/share/postgresql/16)/extension/pg_cron.control" ] \
   && [ ! -f "/usr/share/postgresql/$(basename "$(dirname "$PGBIN")")/extension/pg_cron.control" ]; then
  echo "pg_cron is not installed locally (apt-get install postgresql-16-cron)"; exit 2
fi

"${RUN_AS[@]}" "$PGBIN/initdb" -D "$WORK/data" -U postgres -A trust --no-locale -E UTF8 >/dev/null
"${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -l "$WORK/log" -w start \
  -o "-p $PORT -k $WORK -c listen_addresses='' -c timezone=UTC -c shared_preload_libraries=pg_cron -c cron.database_name=postgres -c cron.host=$WORK" >/dev/null

PSQL=("$PGBIN/psql" -h "$WORK" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q -X)
S="$ROOT/supabase"
M1="$S/migrations/20261110000000_booking_system.sql"
if [ -n "${REHEARSAL_M1_FROM:-}" ]; then
  M1="$WORK/m1-${REHEARSAL_M1_FROM}.sql"
  git -C "$ROOT" show "${REHEARSAL_M1_FROM}:supabase/migrations/20261110000000_booking_system.sql" > "$M1"
  chmod 644 "$M1"
  echo "== Migration 1 taken from commit ${REHEARSAL_M1_FROM}"
fi
pass() { echo "  ok - $1"; }
fail() { echo "  FAIL - $1"; exit 1; }
run() { "${PSQL[@]}" -f "$1" >/dev/null 2>"$WORK/err" || { cat "$WORK/err"; fail "$2"; }; pass "$2"; }
refuse() { # file, expected message, label
  if "${PSQL[@]}" -f "$1" >/dev/null 2>"$WORK/err"; then fail "$3 (not refused)"; fi
  grep -q "$2" "$WORK/err" || { cat "$WORK/err"; fail "$3 (wrong message)"; }
  pass "$3"
}
q() { "${PSQL[@]}" -At -c "$1"; }

echo "== Project as created by Supabase (roles + default privileges)"
"${PSQL[@]}" -f "$S/tests/supabase_roles.sql"

echo "== Wrong order is refused, nothing is changed"
refuse "$S/migrations/20261111000000_closed_days.sql" "Run migration 20261110000000" "migration 2 before 1"
refuse "$S/migrations/20261112000000_webhook.sql" "Run migrations 20261110000000" "migration 3 before 1"
[ "$(q "select count(*) from pg_tables where schemaname='public'")" = "0" ] && pass "database still empty"

echo "== Step 1: migrations in order"
run "$M1" "migration 1"
"${PSQL[@]}" -A -F ' | ' -f "$S/status.sql" | sed 's/^/  status: /'
"${PSQL[@]}" -At -f "$S/status.sql" | grep -q "^5|.*|OK|" && "${PSQL[@]}" -At -f "$S/status.sql" | grep -q "^8|.*|NOT APPLIED|" \
  && pass "status.sql: migration 1 applied and secure, migration 2 not yet applied" || fail "status.sql after migration 1"
run "$S/migrations/20261111000000_closed_days.sql" "migration 2"
run "$S/migrations/20261112000000_webhook.sql" "migration 3"

echo "== Step 2: seed, then holidays"
refuse "$S/holidays.sql" "run seed.sql before holidays.sql" "holidays before seed refused"
run "$S/seed.sql" "seed"
run "$S/holidays.sql" "holidays"

echo "== Step 3: cron"
refuse "$S/cron.sql" "pg_cron is not enabled" "cron.sql before enabling pg_cron refused"
"${PSQL[@]}" -c "create extension pg_cron" >/dev/null && pass "pg_cron enabled (Dashboard step)"
run "$S/cron.sql" "cron jobs scheduled"

echo "== Re-runs are safe"
refuse "$S/migrations/20261110000000_booking_system.sql" "already applied" "migration 1 (current version) again refused"
refuse "$S/migrations/20261112000000_webhook.sql" "already applied" "migration 3 again refused"
run "$S/migrations/20261111000000_closed_days.sql" "migration 2 again (idempotent)"
run "$S/seed.sql" "seed again"
run "$S/holidays.sql" "holidays again"
run "$S/cron.sql" "cron again"
[ "$(q "select count(*) from blackout_periods")" = "17" ] && pass "still 17 holidays" || fail "holidays duplicated"
[ "$(q "select count(*) from cron.job")" = "2" ] && pass "still 2 cron jobs" || fail "cron jobs duplicated"
[ "$(q "select count(*) from packages")" = "3" ] && pass "still 3 packages" || fail "packages duplicated"

echo "== Cron jobs really run"
q "select booking_id from create_booking_hold('pro', (select d from (select (now() at time zone 'Europe/Madrid')::date + i d from generate_series(8,14) i) x where extract(isodow from d)=2 limit 1), '10:00', 'rehearsal', repeat(md5('r'),2))" >/dev/null
q "update bookings set hold_expires_at = now() - interval '1 minute'" >/dev/null
q "select cron.schedule('rehearsal-now', '2 seconds', (select command from cron.job where jobname = 'mrkll-expire-stale-holds'))" >/dev/null
for _ in $(seq 1 20); do
  [ "$(q "select count(*) from bookings where status = 'expired'")" = "1" ] && break
  sleep 0.5
done
[ "$(q "select count(*) from bookings where status = 'expired'")" = "1" ] && pass "expire job released the stale hold" \
  || { q "select status, return_message from cron.job_run_details order by runid desc limit 3"; fail "cron job did not run"; }
[ "$(q "select count(*) from cron.job_run_details where status = 'succeeded'")" -ge 1 ] && pass "cron run recorded as succeeded"
q "select cron.unschedule('rehearsal-now')" >/dev/null
q "select public.purge_stale_hold_data(interval '0 seconds')" >/dev/null && pass "GDPR purge job command runs"
q "delete from bookings; delete from cron.job_run_details" >/dev/null

echo "== status.sql after the whole setup"
[ "$("${PSQL[@]}" -At -f "$S/status.sql" | grep -cE '\|(NOT APPLIED|INCOMPLETE|MISSING|EXPOSED|CHECK|NOT ENABLED)\|')" = "0" ] \
  && pass "status.sql: every step applied, security OK" || { "${PSQL[@]}" -f "$S/status.sql"; fail "status.sql"; }

echo "== verify.sql"
"${PSQL[@]}" -A -F ' | ' -f "$S/verify.sql" | sed 's/^/  /'
[ "$("${PSQL[@]}" -At -f "$S/verify.sql" | grep -c '|FAIL|')" = "0" ] || fail "verify.sql reports failures"
"${PSQL[@]}" -At -f "$S/verify.sql" | grep -q "SUMMARY ===|ALL OK" && pass "verify.sql: ALL OK"

echo "== verify.sql detects problems"
q "alter table public.packages disable row level security" >/dev/null
"${PSQL[@]}" -At -f "$S/verify.sql" | grep -q "RLS enabled on every table|FAIL" && pass "RLS switched off is detected"
q "alter table public.packages enable row level security; grant select on public.bookings to anon" >/dev/null
"${PSQL[@]}" -At -f "$S/verify.sql" | grep -q "anon / authenticated: no access to tables or view|FAIL" && pass "a public grant is detected"
q "revoke select on public.bookings from anon" >/dev/null

echo
echo "STAGING REHEARSAL PASSED"
