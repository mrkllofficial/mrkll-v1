#!/usr/bin/env bash
# Tests scripts/migrations/apply.sh against a throw-away local PostgreSQL
# that looks like Supabase from the client side: TCP + SCRAM password,
# pooler-style user "postgres.<ref>", a pooler host name resolved to
# 127.0.0.1 (PGHOSTADDR), Supabase roles and default privileges, and
# migration 1 from commit 199b81c already applied (the real staging state).
# Never touches Supabase.
#
#   bash scripts/test-migration-runner.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
PORT=5432   # the runner only accepts 5432/6543, like Supabase
WORK="$(mktemp -d)"
RUN_AS=()
if [ "$(id -u)" = "0" ]; then chown postgres "$WORK"; RUN_AS=(runuser -u postgres --); fi
cleanup() { "${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

if (exec 3<>/dev/tcp/127.0.0.1/$PORT) 2>/dev/null; then echo "port $PORT is busy; stop the local PostgreSQL first"; exit 2; fi

REF="abcdefghijklmnopqrst"                       # fake project ref (20 letters)
HOST="aws-0-eu-central-1.pooler.supabase.com"    # never resolved: PGHOSTADDR is used
USER_NAME="postgres.$REF"
PASSWORD="Local-Test-$(head -c 12 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"

"${RUN_AS[@]}" "$PGBIN/initdb" -D "$WORK/data" -U postgres -A trust --no-locale -E UTF8 --auth-host=scram-sha-256 >/dev/null
cat > "$WORK/data/pg_hba.conf" <<EOF
local all postgres trust
host  all all 127.0.0.1/32 scram-sha-256
EOF
"${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -l "$WORK/log" -w start \
  -o "-p $PORT -k $WORK -c listen_addresses=127.0.0.1 -c timezone=UTC -c password_encryption=scram-sha-256" >/dev/null

ADMIN=("$PGBIN/psql" -h "$WORK" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q -X)
for db in staging fresh; do
  "${ADMIN[@]}" -d postgres -c "create database $db" >/dev/null
done
"${ADMIN[@]}" -d postgres -f "$ROOT/supabase/tests/supabase_roles.sql" >/dev/null 2>&1 || true
"${ADMIN[@]}" -d postgres -c "create role \"$USER_NAME\" login nosuperuser password '$PASSWORD'; grant anon, authenticated, service_role to \"$USER_NAME\";" >/dev/null
for db in staging fresh; do
  "${ADMIN[@]}" -d $db -c "grant usage, create on schema public to \"$USER_NAME\";
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;" >/dev/null
done
# staging state: migration 1 from 199b81c applied (as the editor did)
git -C "$ROOT" show 199b81c:supabase/migrations/20261110000000_booking_system.sql > "$WORK/m1.sql"
chmod 644 "$WORK/m1.sql"
PGPASSWORD="$PASSWORD" "$PGBIN/psql" "host=127.0.0.1 port=$PORT dbname=staging user=$USER_NAME sslmode=disable" -q -X -v ON_ERROR_STOP=1 -f "$WORK/m1.sql" >/dev/null

M2="supabase/migrations/20261111000000_closed_days.sql"
M2_SHA="$(sha256sum "$ROOT/$M2" | cut -d' ' -f1)"
STATUS_SHA="$(sha256sum "$ROOT/supabase/status.sql" | cut -d' ' -f1)"
VERIFY_SHA="$(sha256sum "$ROOT/supabase/verify.sql" | cut -d' ' -f1)"

pass() { echo "  ok - $1"; }
check() { local label="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$label"; else fail "$label"; fi; }
fail() { echo "  FAIL - $1"; echo "----- output -----"; cat "$WORK/out" 2>/dev/null; exit 1; }

# Runs apply.sh with the given overrides; output in $WORK/out, summary in $WORK/summary.
run() {
  : > "$WORK/summary"
  (
    cd "$ROOT"
    env -i PATH="$PGBIN:$PATH" HOME="$WORK" \
      MIGRATION_TEST_MODE=1 PGHOSTADDR=127.0.0.1 GITHUB_STEP_SUMMARY="$WORK/summary" GITHUB_SHA=test-commit \
      MIGRATION_FILE="$M2" MIGRATION_SHA256="$M2_SHA" \
      POST_CHECK_FILE="supabase/status.sql" POST_CHECK_SHA256="$STATUS_SHA" \
      STAGING_PROJECT_REF="$REF" STAGING_DB_HOST="$HOST" STAGING_DB_PORT="$PORT" STAGING_DB_NAME=staging \
      STAGING_DB_USER="$USER_NAME" STAGING_DB_PASSWORD="$PASSWORD" STAGING_DB_SSLMODE=disable \
      "$@" bash scripts/migrations/apply.sh
  ) > "$WORK/out" 2>&1
}

# Nothing sensitive may appear in output or summary (add-mask lines are
# GitHub commands consumed by the runner, checked separately).
no_leaks() {
  local text; text="$(grep -hv '^::add-mask::' "$WORK/out" "$WORK/summary" || true)"
  for secret in "$PASSWORD" "$HOST" "$USER_NAME" "$REF" "127.0.0.1"; do
    if printf '%s' "$text" | grep -qF -- "$secret"; then fail "$1: leaked '$secret'"; fi
  done
  pass "$1: no password, host, user, project ref or IP in logs"
}

echo "== 1. Apply migration 2 on the staging state (old migration 1 applied)"
run || fail "apply returned an error"
check "migration applied" grep -q "RESULT: \$\?.*applied\|RESULT: supabase/migrations/20261111000000_closed_days.sql applied." "$WORK/out"
check "file and SHA-256 logged" grep -q "SHA-256        : $M2_SHA (verified)" "$WORK/out"
check "commit logged" grep -q "Commit         : test-commit" "$WORK/out"
check "status.sql: migration 2 APPLIED" grep -qE "8 \| migration 2: closed days in availability +\| APPLIED" "$WORK/out"
check "status.sql: security OK" grep -qE "5 \| security: anon/authenticated have no table access +\| OK" "$WORK/out"
check "post-check OK" grep -q "RESULT: post-check OK" "$WORK/out"
check "job summary written" grep -q "Staging migration — applied" "$WORK/summary"
check "job summary has the SHA-256" grep -q "$M2_SHA" "$WORK/summary"
no_leaks "success"
replaced="$("${ADMIN[@]}" -d staging -At -c "select position('in_closure' in pg_get_functiondef('public.get_availability(text,date,date)'::regprocedure)) > 0")"
check "database: get_availability replaced" test "$replaced" = "t"

echo "== 2. Same request again (idempotent)"
run || fail "second run failed"
pass "re-run succeeds"

echo "== 3. Wrong password"
if run STAGING_DB_PASSWORD="wrong-$PASSWORD"; then fail "wrong password accepted"; fi
check "reported as connection failure" grep -q "connection failed" "$WORK/out"
check "summary says FAILED" grep -q "Staging migration — FAILED" "$WORK/summary"
no_leaks "wrong password"
if grep -qF "wrong-$PASSWORD" "$WORK/out" "$WORK/summary"; then fail "wrong password leaked"; fi

echo "== 4. SQL error -> rollback, database unchanged"
before="$("${ADMIN[@]}" -d fresh -At -c "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'")"
if run STAGING_DB_NAME=fresh; then fail "migration 2 on an empty database succeeded"; fi
check "migration guard message shown" grep -q "Run migration 20261110000000_booking_system.sql first" "$WORK/out"
check "reported as rolled back" grep -q "SQL error: the transaction was rolled back" "$WORK/out"
after="$("${ADMIN[@]}" -d fresh -At -c "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'")"
check "no object created ($after functions in public)" test "$before" = "$after"
no_leaks "sql error"

echo "== 5. Refused before connecting"
expect_refused() { # message, overrides...
  local msg="$1"; shift
  if run "$@"; then fail "accepted: $*"; fi
  grep -qF -- "$msg" "$WORK/out" || fail "expected '$msg' for: $*"
  pass "refused: $msg"
}
expect_refused "SHA-256 mismatch" MIGRATION_SHA256="$(printf '0%.0s' {1..64})"
expect_refused "file not allowed" MIGRATION_FILE="supabase/status.sql"
expect_refused "file not allowed" MIGRATION_FILE="../../etc/passwd"
expect_refused "post-check not allowed" POST_CHECK_FILE="supabase/seed.sql"
expect_refused "STAGING_DB_USER must be postgres.<STAGING_PROJECT_REF>" STAGING_DB_USER="postgres.zyxwvutsrqponmlkjihg"
expect_refused "not a Supabase pooler host" STAGING_DB_HOST="db.example.com"
expect_refused "not a Supabase pooler host" STAGING_DB_HOST="db.zyxwvutsrqponmlkjihg.supabase.co"
expect_refused "not a Supabase project ref" STAGING_PROJECT_REF="prod"
expect_refused "STAGING_DB_PORT must be" STAGING_DB_PORT=15432
expect_refused "STAGING_DB_SSLMODE must be" STAGING_DB_SSLMODE=prefer
expect_refused "sslmode=disable is only allowed in local tests" MIGRATION_TEST_MODE=0
expect_refused "missing configuration: STAGING_DB_PASSWORD" STAGING_DB_PASSWORD=
no_leaks "refusals"

echo "== 6. In GitHub Actions: host, user and ref are masked; sslmode=disable refused"
if run GITHUB_ACTIONS=true; then fail "sslmode=disable accepted in Actions"; fi
for v in "$HOST" "$USER_NAME" "$REF"; do grep -qxF "::add-mask::$v" "$WORK/out" || fail "missing add-mask for a value"; done
pass "::add-mask:: emitted for host, user and project ref"
check "no unencrypted connection from Actions" grep -q "sslmode=disable is only allowed in local tests" "$WORK/out"

echo "== 7. Post-check is read-only and detects problems"
if PGPASSWORD="$PASSWORD" "$PGBIN/psql" "host=127.0.0.1 port=$PORT dbname=staging user=$USER_NAME sslmode=disable" -X -q -v ON_ERROR_STOP=1 \
     -c "set default_transaction_read_only = on" -c "delete from public.bookings" >/dev/null 2>&1; then
  fail "write accepted in the post-check session settings"
fi
pass "a write in the post-check session is refused"
"${ADMIN[@]}" -d staging -c "grant select on public.bookings to anon" >/dev/null
if run; then fail "exposed table not detected"; fi
check "post-check failure (EXPOSED) makes the job fail" grep -q "post-check reports problems" "$WORK/out"
"${ADMIN[@]}" -d staging -c "revoke select on public.bookings from anon" >/dev/null
run POST_CHECK_FILE=supabase/verify.sql POST_CHECK_SHA256="$VERIFY_SHA" || true
check "verify.sql accepted as post-check" grep -q "RESULT: supabase/migrations/20261111000000_closed_days.sql applied." "$WORK/out"
check "verify.sql problems (setup incomplete) make the job fail" grep -qE "post-check reports problems|post-check failed" "$WORK/out"

echo
echo "MIGRATION RUNNER TESTS PASSED"
