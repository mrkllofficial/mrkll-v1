#!/usr/bin/env node
"use strict";

// Validates a staging migration request BEFORE any database access.
//
//   node scripts/migrations/validate-request.js supabase/deploy/staging-request.json
//
// Checks (all must pass, otherwise exit code 1 and nothing is executed):
//   * request format: known fields only, target "staging", one SQL file,
//     no inline SQL, safe request id;
//   * the SQL file: allow-listed path inside the repository, regular file
//     (no symlink), size limit, expected SHA-256, no psql meta-commands,
//     one transaction;
//   * the GitHub environment exists with a required reviewer and a
//     deployment-branch policy that includes the current branch (so the
//     approval gate cannot be missing).
// In GitHub Actions it writes the step outputs and a job summary.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { lintSql } = require("./sql-lint");

const REQUEST_VERSION = 1;
const ENVIRONMENT = "supabase-staging";
const MAX_FILE_BYTES = 1024 * 1024;
const ALLOWED_FILE_RE = /^supabase\/(migrations\/[0-9]{14}_[a-z0-9_]+\.sql|seed\.sql|holidays\.sql|cron\.sql)$/;
const POST_CHECKS = { status: "supabase/status.sql", verify: "supabase/verify.sql" };
const ALLOWED_KEYS = new Set(["version", "target", "file", "sha256", "request_id", "reason", "post_check"]);
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

class RequestError extends Error {
  constructor(problems) {
    super(problems.join("\n"));
    this.problems = problems;
  }
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// Reads a repository file safely: allow-listed relative path, inside the
// root, regular file, not a symlink, size-limited.
function readRepoFile(root, relative, problems, label) {
  if (typeof relative !== "string" || path.isAbsolute(relative) || relative.split("/").includes("..")) {
    problems.push(`${label}: invalid path`);
    return null;
  }
  const full = path.join(root, relative);
  let stat;
  try {
    stat = fs.lstatSync(full);
  } catch {
    problems.push(`${label}: ${relative} does not exist in this commit`);
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    problems.push(`${label}: ${relative} must be a regular file (no symlink)`);
    return null;
  }
  const realRoot = fs.realpathSync(root);
  const real = fs.realpathSync(full);
  if (!real.startsWith(realRoot + path.sep)) {
    problems.push(`${label}: ${relative} is outside the repository`);
    return null;
  }
  if (stat.size > MAX_FILE_BYTES) {
    problems.push(`${label}: ${relative} is larger than ${MAX_FILE_BYTES} bytes`);
    return null;
  }
  return fs.readFileSync(full);
}

function validateRequest(rawJson, root) {
  const problems = [];
  let req;
  try {
    req = JSON.parse(rawJson);
  } catch {
    throw new RequestError(["request: not valid JSON"]);
  }
  if (req === null || typeof req !== "object" || Array.isArray(req)) {
    throw new RequestError(["request: must be a JSON object"]);
  }

  for (const key of Object.keys(req)) {
    if (!ALLOWED_KEYS.has(key)) problems.push(`request: unknown field "${key}" (inline SQL or extra options are not accepted)`);
  }
  if (req.version !== REQUEST_VERSION) problems.push(`request: "version" must be ${REQUEST_VERSION}`);
  if (req.target !== "staging") problems.push('request: "target" must be "staging"');
  if (typeof req.file !== "string" || !ALLOWED_FILE_RE.test(req.file)) {
    problems.push('request: "file" must be one of supabase/migrations/<14 digits>_<name>.sql, supabase/seed.sql, supabase/holidays.sql, supabase/cron.sql');
  }
  if (typeof req.sha256 !== "string" || !SHA256_RE.test(req.sha256)) problems.push('request: "sha256" must be 64 lowercase hex characters');
  if (typeof req.request_id !== "string" || !REQUEST_ID_RE.test(req.request_id)) {
    problems.push('request: "request_id" must be 1-64 characters [A-Za-z0-9._-]');
  }
  if (typeof req.reason !== "string" || req.reason.trim().length < 3 || req.reason.length > 200 || /[\u0000-\u001f\u007f]/.test(req.reason)) {
    problems.push('request: "reason" must be 3-200 printable characters on one line');
  }
  const postCheck = req.post_check === undefined ? "status" : req.post_check;
  if (!Object.prototype.hasOwnProperty.call(POST_CHECKS, postCheck)) problems.push('request: "post_check" must be "status" or "verify"');
  if (problems.length) throw new RequestError(problems);

  const content = readRepoFile(root, req.file, problems, "file");
  if (content) {
    const actual = sha256(content);
    if (actual !== req.sha256) problems.push(`file: SHA-256 mismatch for ${req.file} (expected ${req.sha256}, found ${actual})`);
    for (const p of lintSql(content.toString("utf8"))) problems.push(`file: ${p}`);
  }
  const check = readRepoFile(root, POST_CHECKS[postCheck], problems, "post_check");
  if (check) {
    for (const p of lintSql(check.toString("utf8"))) problems.push(`post_check: ${p}`);
  }
  if (problems.length) throw new RequestError(problems);

  return {
    file: req.file,
    sha256: req.sha256,
    requestId: req.request_id,
    reason: req.reason.trim(),
    postCheckFile: POST_CHECKS[postCheck],
    postCheckSha256: sha256(check),
  };
}

// The approval gate must exist BEFORE the apply job is queued: a job that
// references a missing environment would make GitHub create it without
// protection rules. Fails closed on any doubt.
async function checkEnvironmentProtection({ apiUrl, repository, environment, branch, token, fetchImpl = fetch }) {
  const get = async (url) => {
    const headers = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "mrkll-migrations" };
    let res = await fetchImpl(url, { headers: token ? { ...headers, authorization: `Bearer ${token}` } : headers });
    if ((res.status === 401 || res.status === 403) && token) {
      res = await fetchImpl(url, { headers }); // public repository: readable without a token
    }
    return res;
  };
  const base = `${apiUrl}/repos/${repository}/environments/${encodeURIComponent(environment)}`;

  const envRes = await get(base);
  if (envRes.status === 404) {
    throw new RequestError([`environment "${environment}" does not exist: create it (with a required reviewer) before requesting a migration`]);
  }
  if (envRes.status !== 200) throw new RequestError([`environment "${environment}": cannot verify protection rules (HTTP ${envRes.status})`]);
  const env = await envRes.json();

  const problems = [];
  const reviewers = (env.protection_rules || []).filter((r) => r.type === "required_reviewers");
  if (!reviewers.some((r) => Array.isArray(r.reviewers) && r.reviewers.length > 0)) {
    problems.push(`environment "${environment}": a required reviewer is mandatory`);
  }
  const policy = env.deployment_branch_policy;
  if (!policy || policy.custom_branch_policies !== true) {
    problems.push(`environment "${environment}": deployment branches must be limited to selected branches`);
  } else {
    const polRes = await get(`${base}/deployment-branch-policies?per_page=100`);
    if (polRes.status !== 200) {
      problems.push(`environment "${environment}": cannot read deployment branch policies (HTTP ${polRes.status})`);
    } else {
      const body = await polRes.json();
      const names = (body.branch_policies || []).filter((p) => (p.type || "branch") === "branch").map((p) => p.name);
      if (!names.includes(branch)) problems.push(`environment "${environment}": branch "${branch}" is not in its deployment branches`);
    }
  }
  if (problems.length) throw new RequestError(problems);
  return { reviewers: reviewers.reduce((n, r) => n + (r.reviewers || []).length, 0) };
}

function appendFileSafe(file, text) {
  if (file) fs.appendFileSync(file, text);
}

async function main(argv = process.argv, env = process.env) {
  const requestPath = argv[2] || "supabase/deploy/staging-request.json";
  const root = process.cwd();
  const inActions = env.GITHUB_ACTIONS === "true";

  try {
    const raw = readRepoFile(root, requestPath, [], "request");
    if (!raw) throw new RequestError([`request: ${requestPath} not found`]);
    const result = validateRequest(raw.toString("utf8"), root);

    if (inActions || env.MIGRATION_CHECK_ENVIRONMENT === "1") {
      await checkEnvironmentProtection({
        apiUrl: env.GITHUB_API_URL || "https://api.github.com",
        repository: env.GITHUB_REPOSITORY,
        environment: env.MIGRATION_ENVIRONMENT || ENVIRONMENT,
        branch: env.GITHUB_REF_NAME,
        token: env.GITHUB_TOKEN,
      });
    }

    const commit = env.GITHUB_SHA || "local";
    appendFileSafe(env.GITHUB_OUTPUT, [
      `file=${result.file}`,
      `sha256=${result.sha256}`,
      `request_id=${result.requestId}`,
      `post_check=${result.postCheckFile}`,
      `post_check_sha256=${result.postCheckSha256}`,
      "",
    ].join("\n"));
    appendFileSafe(env.GITHUB_STEP_SUMMARY, [
      "### Staging migration request — validated",
      "",
      "| Field | Value |",
      "|---|---|",
      `| Request | \`${result.requestId}\` |`,
      `| Reason | ${result.reason.replace(/\|/g, "/")} |`,
      `| File | \`${result.file}\` |`,
      `| SHA-256 | \`${result.sha256}\` |`,
      `| Post-check | \`${result.postCheckFile}\` (read-only) |`,
      `| Commit | \`${commit}\` |`,
      `| Branch | \`${env.GITHUB_REF_NAME || "local"}\` |`,
      "",
      "Waiting for approval of the `supabase-staging` environment before any SQL is executed.",
      "",
    ].join("\n"));

    console.log(`Request ${result.requestId}: ${result.file} (sha256 ${result.sha256}) at commit ${commit} — valid.`);
    console.log(`Post-check: ${result.postCheckFile} (read-only).`);
    return 0;
  } catch (error) {
    const problems = error instanceof RequestError ? error.problems : [String(error && error.message)];
    console.error("Migration request REJECTED — nothing will be executed:");
    for (const p of problems) console.error(`  - ${p}`);
    appendFileSafe(env.GITHUB_STEP_SUMMARY, ["### Staging migration request — rejected", "", ...problems.map((p) => `- ${p}`), ""].join("\n"));
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => process.exit(code));
}

module.exports = { validateRequest, checkEnvironmentProtection, main, RequestError, ALLOWED_FILE_RE, POST_CHECKS };
