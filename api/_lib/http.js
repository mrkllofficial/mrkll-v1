"use strict";

// Small, framework-free HTTP helpers. They only use the plain Node.js
// response API (statusCode / setHeader / end), so handlers behave the same
// on Vercel and in tests.

function sendJson(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }
  res.end(JSON.stringify(body));
}

function sendError(res, status, code, message, extra = {}, headers = {}) {
  sendJson(res, status, { error: { code, message, ...extra } }, headers);
}

// Returns true when the method is allowed; otherwise answers 405.
function allowMethods(req, res, methods) {
  if (methods.includes(req.method)) {
    return true;
  }
  sendError(res, 405, "METHOD_NOT_ALLOWED", "Method not allowed", {}, { Allow: methods.join(", ") });
  return false;
}

// Query parameters as { name: string }. Repeated parameters are rejected
// by returning an array, which validators treat as invalid.
function getQuery(req) {
  if (req.query && typeof req.query === "object") {
    return req.query;
  }
  const url = new URL(req.url || "/", "http://localhost");
  const query = {};
  for (const [key, value] of url.searchParams) {
    if (key in query) {
      query[key] = [].concat(query[key], value);
    } else {
      query[key] = value;
    }
  }
  return query;
}

// Structured logs; never pass secrets or full personal data here.
function log(level, event, fields = {}) {
  const line = JSON.stringify({ level, event, ...fields });
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

module.exports = { sendJson, sendError, allowMethods, getQuery, log };
