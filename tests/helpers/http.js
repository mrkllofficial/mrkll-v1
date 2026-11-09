"use strict";

const { Readable } = require("stream");

// Calls a handler with a minimal fake request/response, like Vercel would.
//   query   -> req.query (as Vercel provides it)
//   body    -> req.body already parsed (as Vercel does for JSON)
//   stream  -> raw body string delivered as a stream (req.body undefined)
async function invoke(handler, { method = "GET", url = "/", query, headers = {}, body, stream } = {}) {
  const resHeaders = {};
  let resBody = "";
  const lowerHeaders = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));

  let req;
  if (stream !== undefined) {
    req = Readable.from([Buffer.from(stream)]);
  } else {
    req = { on() {} };
    if (body !== undefined) req.body = body;
  }
  Object.assign(req, { method, url, headers: lowerHeaders, socket: { remoteAddress: "127.0.0.1" } });
  if (query) req.query = query;

  const res = {
    statusCode: 200,
    setHeader(name, value) {
      resHeaders[name.toLowerCase()] = value;
    },
    getHeader(name) {
      return resHeaders[name.toLowerCase()];
    },
    end(chunk) {
      resBody = chunk === undefined ? "" : String(chunk);
    },
  };
  await handler(req, res);
  let json = null;
  try {
    json = resBody ? JSON.parse(resBody) : null;
  } catch {
    json = null;
  }
  return { status: res.statusCode, headers: resHeaders, body: resBody, json };
}

const SITE = "https://mrkll.test";

// A JSON POST as sent by the checkout page.
function postJson(handler, body, { origin = SITE, ip = "203.0.113.10", headers = {} } = {}) {
  return invoke(handler, {
    method: "POST",
    headers: { "content-type": "application/json", origin, "x-real-ip": ip, ...headers },
    body,
  });
}

module.exports = { invoke, postJson, SITE };
