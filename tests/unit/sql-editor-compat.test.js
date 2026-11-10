"use strict";

// The Supabase SQL Editor checks queries with a SQL parser (sqlparser-rs)
// before running them. It rejects DO blocks ("Expected: an SQL statement,
// found: do") and EXCLUDE constraints. Files meant to be pasted there must
// avoid both (verified separately with sqlparser-rs itself).

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

// Removes comments and dollar-quoted bodies (function bodies are opaque to the parser).
function topLevel(sql) {
  let out = "";
  for (let i = 0; i < sql.length;) {
    if (sql.startsWith("--", i)) { const j = sql.indexOf("\n", i); i = j < 0 ? sql.length : j; continue; }
    const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
    if (m) { const end = sql.indexOf(m[0], i + m[0].length); out += " $body$ "; i = end + m[0].length; continue; }
    if (sql[i] === "'") { const end = sql.indexOf("'", i + 1); out += " 'str' "; i = end + 1; continue; }
    out += sql[i++];
  }
  return out;
}

for (const file of PASTE_FILES) {
  test(`${file}: compatible with the Supabase SQL Editor`, () => {
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
