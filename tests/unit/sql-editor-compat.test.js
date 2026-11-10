"use strict";

// Portability lint for the setup files. They are run with psql (the
// Supabase SQL Editor's validator also rejects CREATE FUNCTION/TRIGGER, so
// it cannot be used for the migrations). Still: no DO blocks, no bare
// EXCLUDE, no psql meta-commands, no DROP, one transaction per file — and
// status.sql / verify.sql / seed.sql stay usable in the SQL Editor.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "../../supabase");
const PASTE_FILES = [
  "migrations/20261110000000_booking_system.sql",
  "migrations/20261111000000_closed_days.sql",
  "migrations/20261112000000_webhook.sql",
  "seed.sql",
  "holidays.sql",
  "cron.sql",
  "verify.sql",
  "status.sql",
];

const { topLevel } = require("../../scripts/migrations/sql-lint");

for (const file of PASTE_FILES) {
  test(`${file}: portable, transactional, no psql meta-commands`, () => {
    const sql = fs.readFileSync(path.join(DIR, file), "utf8");
    const top = topLevel(sql);
    assert.doesNotMatch(top, /(^|;)\s*do\s/im, "no DO blocks");
    assert.doesNotMatch(top, /\bexclude\s+using\b/i, "no EXCLUDE constraint outside dynamic SQL");
    assert.doesNotMatch(sql, /^\s*\\[a-z]/im, "no psql meta-commands");
    assert.doesNotMatch(sql, /\r/, "Unix line endings");
    assert.doesNotMatch(top, /(^|;)\s*drop\s/im, "no DROP statements (avoids destructive prompts)");
    const statements = top.split(";").map((x) => x.trim()).filter(Boolean);
    if (statements.length > 1) {
      assert.match(statements[0], /^begin$/i, "multi-statement files start a transaction");
      assert.match(statements[statements.length - 1], /^commit$/i, "and commit it at the end");
    }
  });
}
