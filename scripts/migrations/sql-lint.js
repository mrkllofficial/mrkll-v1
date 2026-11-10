"use strict";

// Static checks for SQL files that are executed with psql against Supabase.
// Shared by the migration workflow (scripts/migrations/validate-request.js)
// and the test suite. No dependencies.

class SqlLintError extends Error {}

// Top-level text of a SQL script: comments removed, string literals and
// dollar-quoted bodies (function bodies, cron commands) replaced by
// placeholders. Unterminated quotes are reported as errors.
function topLevel(sql) {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    if (sql.startsWith("--", i)) {
      const j = sql.indexOf("\n", i);
      i = j < 0 ? sql.length : j;
      continue;
    }
    if (sql.startsWith("/*", i)) {
      const j = sql.indexOf("*/", i + 2);
      if (j < 0) throw new SqlLintError("unterminated /* comment");
      i = j + 2;
      continue;
    }
    const dollar = /^\$[A-Za-z_][A-Za-z_0-9]*\$|^\$\$/.exec(sql.slice(i, i + 64));
    if (dollar) {
      const end = sql.indexOf(dollar[0], i + dollar[0].length);
      if (end < 0) throw new SqlLintError(`unterminated ${dollar[0]} quoted body`);
      out += " $body$ ";
      i = end + dollar[0].length;
      continue;
    }
    if (sql[i] === "'") {
      let j = i + 1;
      for (;;) {
        j = sql.indexOf("'", j);
        if (j < 0) throw new SqlLintError("unterminated string literal");
        if (sql[j + 1] === "'") { j += 2; continue; } // escaped quote
        break;
      }
      out += " 'str' ";
      i = j + 1;
      continue;
    }
    out += sql[i];
    i += 1;
  }
  return out;
}

function statements(sql) {
  return topLevel(sql).split(";").map((s) => s.trim()).filter(Boolean);
}

// Returns a list of problems (empty when the file is acceptable).
//   requireTransaction: multi-statement files must be wrapped in BEGIN … COMMIT
function lintSql(sql, { requireTransaction = true } = {}) {
  const problems = [];
  if (sql.includes("\r")) problems.push("Windows line endings (CR) are not allowed");
  if (sql.includes("\u0000")) problems.push("NUL bytes are not allowed");
  // psql meta-commands (\! runs shell commands, \i includes other files, \copy, \set …)
  if (/^[ \t]*\\/m.test(sql)) problems.push("psql meta-commands (lines starting with \\) are not allowed");

  let top;
  try {
    top = topLevel(sql);
  } catch (error) {
    problems.push(error.message);
    return problems;
  }
  if (/(^|;)\s*do\s/i.test(top)) problems.push("DO blocks are not allowed (use a pg_temp function)");
  if (/\bexclude\s+using\b/i.test(top)) problems.push("EXCLUDE constraints must be added through dynamic SQL");

  const parts = top.split(";").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) problems.push("the file contains no SQL statement");
  if (requireTransaction && parts.length > 1) {
    if (!/^begin$/i.test(parts[0])) problems.push("multi-statement files must start with BEGIN;");
    if (!/^commit$/i.test(parts[parts.length - 1])) problems.push("multi-statement files must end with COMMIT;");
    const inner = parts.slice(1, -1);
    if (inner.some((s) => /^(begin|commit|rollback|end|start\s+transaction)\b/i.test(s))) {
      problems.push("only one transaction per file is allowed");
    }
  }
  return problems;
}

module.exports = { topLevel, statements, lintSql, SqlLintError };
