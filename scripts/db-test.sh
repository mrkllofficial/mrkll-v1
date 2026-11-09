#!/usr/bin/env bash
# Runs the booking-system migration and tests against a throw-away local
# PostgreSQL cluster. Never touches Supabase. Requires PostgreSQL 15+ binaries.
#
#   bash scripts/db-test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
WORK="$(mktemp -d)"
PORT="${PGPORT_TEST:-54329}"
RUN_AS=()
if [ "$(id -u)" = "0" ]; then
  chown postgres "$WORK"
  RUN_AS=(runuser -u postgres --)
fi

cleanup() {
  "${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

"${RUN_AS[@]}" "$PGBIN/initdb" -D "$WORK/data" -U postgres -A trust --no-locale -E UTF8 >/dev/null
"${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses='' -c timezone=UTC" -l "$WORK/log" -w start >/dev/null

PSQL=("$PGBIN/psql" -h "$WORK" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q -X)

echo "== Supabase roles (simulated)"
"${PSQL[@]}" -f "$ROOT/supabase/tests/supabase_roles.sql"
echo "== Migration"
"${PSQL[@]}" -f "$ROOT"/supabase/migrations/*_booking_system.sql
echo "== Seed (twice, must be idempotent)"
"${PSQL[@]}" -f "$ROOT/supabase/seed.sql"
"${PSQL[@]}" -f "$ROOT/supabase/seed.sql"
echo "== Tests"
if ! OUT=$("${PSQL[@]}" -At -o /dev/null -f "$ROOT/supabase/tests/booking_system.test.sql" 2>&1); then
  echo "$OUT" | sed 's/^psql:[^:]*:[0-9]*: \(NOTICE\|ERROR\):  /  /'
  echo "FAIL: database tests"; exit 1
fi
echo "$OUT" | sed 's/^psql:[^:]*:[0-9]*: NOTICE:  /  /'
echo "  -> $(echo "$OUT" | grep -c ' ok - ') assertions passed"

echo "== Concurrency: 20 parallel holds on the same slot"
DAY="$("${PSQL[@]}" -At -c "select d from (select (now() at time zone 'Europe/Madrid')::date + i d from generate_series(8,14) i) x where extract(isodow from d)=2 limit 1")"
for i in $(seq 1 20); do
  ( "${PSQL[@]}" -At -c "select reference from create_booking_hold('pro','$DAY','15:00','ip$i',repeat(md5('$i'),2))" >"$WORK/c$i.out" 2>"$WORK/c$i.err" || true ) &
done
wait
OK=$(cat "$WORK"/c*.out | grep -c '^MRK-' || true)
TAKEN=$(cat "$WORK"/c*.err | grep -c 'SLOT_UNAVAILABLE' || true)
ROWS=$("${PSQL[@]}" -At -c "select count(*) from bookings where status='pending_payment'")
echo "  successes=$OK  rejected(SLOT_UNAVAILABLE)=$TAKEN  active rows=$ROWS"
if [ "$OK" != "1" ] || [ "$TAKEN" != "19" ] || [ "$ROWS" != "1" ]; then
  echo "FAIL: concurrency"; exit 1
fi
echo "ok - exactly one of 20 concurrent requests obtained the slot"

echo "== Overlapping packages in parallel (pro 12:30 vs legend 12:30 vs starter 12:30)"
"${PSQL[@]}" -c "delete from bookings" >/dev/null
for p in pro legend starter pro legend starter; do
  ( "${PSQL[@]}" -At -c "select reference from create_booking_hold('$p','$DAY','12:30','x$p$RANDOM',repeat(md5('$p$RANDOM'),2))" >"$WORK/o$p$RANDOM.out" 2>/dev/null || true ) &
done
wait
ROWS=$("${PSQL[@]}" -At -c "select count(*) from bookings where status='pending_payment'")
[ "$ROWS" = "1" ] || { echo "FAIL: overlapping parallel holds ($ROWS rows)"; exit 1; }
echo "ok - only one overlapping hold survived"

echo
echo "ALL CHECKS PASSED"
