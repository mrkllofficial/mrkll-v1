#!/usr/bin/env bash
# =====================================================================
# Applies ONE validated SQL file to the Supabase STAGING database, then
# runs a read-only post-check. Called by .github/workflows/
# supabase-staging-migration.yml after approval; never run by hand with
# real credentials.
#
# Inputs (environment variables):
#   MIGRATION_FILE, MIGRATION_SHA256        file to run and its expected hash
#   POST_CHECK_FILE, POST_CHECK_SHA256      read-only check (status.sql/verify.sql)
#   STAGING_PROJECT_REF, STAGING_DB_HOST, STAGING_DB_PORT, STAGING_DB_NAME,
#   STAGING_DB_USER                         non-secret connection data (environment variables)
#   STAGING_DB_PASSWORD                     the only secret (environment secret)
#   STAGING_DB_SSLMODE                      optional: require (default) | verify-ca | verify-full
#   STAGING_DB_SSLROOTCERT                  optional: CA file in the repo for verify-*
#
# Nothing sensitive is printed: no connection string is ever built, host,
# user and project ref are masked in GitHub logs, and psql errors are
# sanitised before being shown.
# =====================================================================
set -Eeuo pipefail
umask 077

started=$(date -u +%s)
WORK="$(mktemp -d)"
cleanup() {
  unset PGPASSWORD STAGING_DB_PASSWORD
  rm -rf "$WORK"
}
trap cleanup EXIT

summary() { if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$@" >> "$GITHUB_STEP_SUMMARY"; fi; }
fail() {
  echo "ERROR: $*" >&2
  summary "### Staging migration — FAILED" "" "- $*" ""
  exit 1
}

# ---------------------------------------------------------------------
# 1. Inputs present (names only are reported, never values)
# ---------------------------------------------------------------------
missing=()
for name in MIGRATION_FILE MIGRATION_SHA256 POST_CHECK_FILE POST_CHECK_SHA256 \
            STAGING_PROJECT_REF STAGING_DB_HOST STAGING_DB_PORT STAGING_DB_NAME STAGING_DB_USER STAGING_DB_PASSWORD; do
  [ -n "${!name:-}" ] || missing+=("$name")
done
[ ${#missing[@]} -eq 0 ] || fail "missing configuration: ${missing[*]} (set them on the supabase-staging environment)"

# ---------------------------------------------------------------------
# 2. Mask non-secret connection data in GitHub logs (the password is
#    masked automatically because it is a secret)
# ---------------------------------------------------------------------
if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  for value in "$STAGING_PROJECT_REF" "$STAGING_DB_HOST" "$STAGING_DB_USER"; do
    echo "::add-mask::$value"
  done
fi

sanitize() {
  local text="$1"
  text="${text//"$STAGING_DB_PASSWORD"/<password>}"
  text="${text//"$STAGING_DB_HOST"/<host>}"
  text="${text//"$STAGING_DB_USER"/<user>}"
  text="${text//"$STAGING_PROJECT_REF"/<project>}"
  printf '%s' "$text" | sed -E \
    -e 's/[0-9]{1,3}(\.[0-9]{1,3}){3}/<ip>/g' \
    -e 's/([0-9a-fA-F]{1,4}:){5,7}[0-9a-fA-F]{1,4}/<ip>/g' \
    -e 's/([0-9a-fA-F]{1,4}:)+:([0-9a-fA-F]{1,4}:?)*/<ip>/g' \
    -e 's/(password|passwd)=[^ ]*/\1=<hidden>/Ig'
}

# ---------------------------------------------------------------------
# 3. Staging-only guard: the connection data must describe one Supabase
#    project consistently (pooler user postgres.<ref>, or direct host
#    db.<ref>.supabase.co with user postgres)
# ---------------------------------------------------------------------
ref="$STAGING_PROJECT_REF"
[[ "$ref" =~ ^[a-z]{20}$ ]] || fail "STAGING_PROJECT_REF is not a Supabase project ref (20 lowercase letters)"
if [[ "$STAGING_DB_HOST" =~ ^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$ ]]; then
  [ "$STAGING_DB_USER" = "postgres.$ref" ] || fail "with the pooler host, STAGING_DB_USER must be postgres.<STAGING_PROJECT_REF>"
elif [ "$STAGING_DB_HOST" = "db.$ref.supabase.co" ]; then
  [ "$STAGING_DB_USER" = "postgres" ] || fail "with the direct host, STAGING_DB_USER must be postgres"
else
  fail "STAGING_DB_HOST is not a Supabase pooler host or db.<STAGING_PROJECT_REF>.supabase.co"
fi
[[ "$STAGING_DB_PORT" =~ ^(5432|6543)$ ]] || fail "STAGING_DB_PORT must be 5432 (session pooler / direct) or 6543"
[[ "$STAGING_DB_NAME" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || fail "STAGING_DB_NAME is not a valid database name"

sslmode="${STAGING_DB_SSLMODE:-require}"
case "$sslmode" in
  require|verify-ca|verify-full) ;;
  disable) [ "${MIGRATION_TEST_MODE:-}" = "1" ] && [ "${GITHUB_ACTIONS:-}" != "true" ] || fail "sslmode=disable is only allowed in local tests" ;;
  *) fail "STAGING_DB_SSLMODE must be require, verify-ca or verify-full" ;;
esac

# ---------------------------------------------------------------------
# 4. Files: allow-listed, unchanged since validation
# ---------------------------------------------------------------------
[[ "$MIGRATION_FILE" =~ ^supabase/(migrations/[0-9]{14}_[a-z0-9_]+\.sql|seed\.sql|holidays\.sql|cron\.sql)$ ]] || fail "file not allowed: $MIGRATION_FILE"
[[ "$POST_CHECK_FILE" =~ ^supabase/(status|verify)\.sql$ ]] || fail "post-check not allowed: $POST_CHECK_FILE"
for pair in "$MIGRATION_FILE:$MIGRATION_SHA256" "$POST_CHECK_FILE:$POST_CHECK_SHA256"; do
  f="${pair%%:*}"; expected="${pair##*:}"
  [ -f "$f" ] && [ ! -L "$f" ] || fail "$f is missing or is a symlink"
  actual="$(sha256sum "$f" | cut -d' ' -f1)"
  [ "$actual" = "$expected" ] || fail "SHA-256 mismatch for $f (expected $expected, found $actual)"
done
# shellcheck disable=SC1003  # the pattern matches a literal backslash (psql meta-commands)
if grep -qE '^[[:space:]]*\\' "$MIGRATION_FILE" "$POST_CHECK_FILE"; then fail "psql meta-commands are not allowed"; fi

commit="${GITHUB_SHA:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"
echo "Migration file : $MIGRATION_FILE"
echo "SHA-256        : $MIGRATION_SHA256 (verified)"
echo "Commit         : $commit"
echo "Post-check     : $POST_CHECK_FILE (read-only, sha256 verified)"
echo "Target         : Supabase staging project (connection data masked)"
echo "psql           : $(psql --version)"

# ---------------------------------------------------------------------
# 5. Connection through standard libpq variables (never a URL)
# ---------------------------------------------------------------------
export PGHOST="$STAGING_DB_HOST" PGPORT="$STAGING_DB_PORT" PGDATABASE="$STAGING_DB_NAME" \
       PGUSER="$STAGING_DB_USER" PGPASSWORD="$STAGING_DB_PASSWORD" PGSSLMODE="$sslmode" \
       PGAPPNAME="mrkll-migrations" PGCONNECT_TIMEOUT="20"
if [ -n "${STAGING_DB_SSLROOTCERT:-}" ]; then
  [ -f "$STAGING_DB_SSLROOTCERT" ] || fail "STAGING_DB_SSLROOTCERT file not found"
  export PGSSLROOTCERT="$STAGING_DB_SSLROOTCERT"
fi
unset PGSERVICE PGSERVICEFILE PGPASSFILE

run_psql() { # label, log file, psql args...
  local label="$1" log="$2"; shift 2
  local rc=0
  psql -X --no-password -v ON_ERROR_STOP=1 "$@" >"$log.out" 2>"$log.err" || rc=$?
  sanitize "$(cat "$log.out")"; echo
  if [ -s "$log.err" ]; then
    echo "--- $label: messages ---"
    sanitize "$(cat "$log.err")"; echo
  fi
  return $rc
}

# ---------------------------------------------------------------------
# 6. Apply (the file is one transaction: an error changes nothing)
# ---------------------------------------------------------------------
echo "=== Applying $MIGRATION_FILE ==="
rc=0
run_psql "migration" "$WORK/apply" \
  -c "set lock_timeout = '15s'" \
  -c "set statement_timeout = '10min'" \
  -f "$MIGRATION_FILE" || rc=$?
if [ $rc -ne 0 ]; then
  case $rc in
    2) why="connection failed (check the supabase-staging variables and secret)" ;;
    3) why="SQL error: the transaction was rolled back, the database is unchanged" ;;
    *) why="psql exited with code $rc" ;;
  esac
  summary "### Staging migration — FAILED" "" "| Field | Value |" "|---|---|" \
    "| File | \`$MIGRATION_FILE\` |" "| SHA-256 | \`$MIGRATION_SHA256\` |" "| Commit | \`$commit\` |" "| Result | $why |" ""
  echo "RESULT: FAILED — $why" >&2
  exit 1
fi
echo "RESULT: $MIGRATION_FILE applied."

# ---------------------------------------------------------------------
# 7. Read-only post-check (the session refuses any write)
# ---------------------------------------------------------------------
echo "=== Post-check $POST_CHECK_FILE (read-only) ==="
rc=0
run_psql "post-check" "$WORK/check" \
  -c "set default_transaction_read_only = on" \
  -c "set statement_timeout = '2min'" \
  -f "$POST_CHECK_FILE" || rc=$?
check_output="$(sanitize "$(cat "$WORK/check.out")")"
check_result="OK"
if [ $rc -ne 0 ]; then
  check_result="post-check failed (exit $rc)"
elif printf '%s' "$check_output" | grep -qE '\| *(FAIL|EXPOSED|MISSING|INCOMPLETE|CHECK|SOME CHECKS FAILED) *(\||$)'; then
  check_result="post-check reports problems"
fi

elapsed=$(( $(date -u +%s) - started ))
summary "### Staging migration — applied" "" "| Field | Value |" "|---|---|" \
  "| File | \`$MIGRATION_FILE\` |" "| SHA-256 | \`$MIGRATION_SHA256\` |" "| Commit | \`$commit\` |" \
  "| Result | applied |" "| Post-check | \`$POST_CHECK_FILE\`: $check_result |" "| Duration | ${elapsed}s |" "" \
  '```' "$check_output" '```' ""

if [ "$check_result" != "OK" ]; then
  echo "RESULT: migration applied, but $check_result" >&2
  exit 1
fi
echo "RESULT: post-check OK (${elapsed}s)."
