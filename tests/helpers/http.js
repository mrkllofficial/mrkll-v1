"use strict";

// Calls a handler with a minimal fake request/response, like Vercel would.
async function invoke(handler, { method = "GET", url = "/", query } = {}) {
  const headers = {};
  let body = "";
  const req = { method, url, headers: {} };
  if (query) req.query = query;
  const res = {
    statusCode: 200,
    setHeader(name, value) {
      headers[name.toLowerCase()] = value;
    },
    getHeader(name) {
      return headers[name.toLowerCase()];
    },
    end(chunk) {
      body = chunk === undefined ? "" : String(chunk);
    },
  };
  await handler(req, res);
  let json = null;
  try {
    json = body ? JSON.parse(body) : null;
  } catch {
    json = null;
  }
  return { status: res.statusCode, headers, body, json };
}

module.exports = { invoke };
