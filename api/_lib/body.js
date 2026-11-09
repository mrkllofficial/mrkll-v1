"use strict";

// Reads a small JSON request body. Rejects other content types (a
// cross-site HTML form cannot send application/json without a CORS
// preflight, which this API never grants) and bodies over the size limit.

class BodyError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "BodyError";
    this.status = status;
    this.code = code;
  }
}

const MAX_BYTES = 4 * 1024;

function isJsonContentType(req) {
  const type = String((req.headers && req.headers["content-type"]) || "").toLowerCase();
  return type.split(";")[0].trim() === "application/json";
}

function readStream(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        reject(new BodyError(413, "PAYLOAD_TOO_LARGE", "Request body too large."));
        req.destroy && req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJsonBody(req) {
  if (!isJsonContentType(req)) {
    throw new BodyError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json.");
  }

  let value;
  try {
    // On Vercel, req.body is already parsed (getter that throws on bad JSON).
    value = req.body;
  } catch {
    throw new BodyError(400, "INVALID_JSON", "Invalid JSON body.");
  }

  if (value === undefined && typeof req.on === "function") {
    value = await readStream(req);
  }
  if (typeof value === "string" || Buffer.isBuffer(value)) {
    const text = value.toString();
    if (Buffer.byteLength(text) > MAX_BYTES) {
      throw new BodyError(413, "PAYLOAD_TOO_LARGE", "Request body too large.");
    }
    try {
      value = text ? JSON.parse(text) : undefined;
    } catch {
      throw new BodyError(400, "INVALID_JSON", "Invalid JSON body.");
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BodyError(400, "INVALID_JSON", "A JSON object is required.");
  }
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) {
    throw new BodyError(413, "PAYLOAD_TOO_LARGE", "Request body too large.");
  }
  return value;
}

module.exports = { readJsonBody, BodyError, MAX_BYTES };
