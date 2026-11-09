"use strict";

const crypto = require("crypto");

// Random secret returned to the browser that lets it release its own hold.
// Only its SHA-256 hash is stored in the database.
function generateReleaseToken() {
  return crypto.randomBytes(32).toString("base64url"); // 43 characters
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
}

const RELEASE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
function isReleaseToken(value) {
  return typeof value === "string" && RELEASE_TOKEN_RE.test(value);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

// Client IP as seen by Vercel's edge (which overwrites these headers, so a
// client cannot spoof them). Falls back to the socket address locally.
function getClientIp(req) {
  const headers = req.headers || {};
  const realIp = headers["x-real-ip"];
  if (typeof realIp === "string" && realIp.trim()) return realIp.trim();
  const forwarded = headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

// Keyed hash: the raw IP is never stored.
function hashIp(ip, salt) {
  return crypto.createHmac("sha256", salt).update(String(ip)).digest("hex");
}

// Browser requests must come from the site itself. Requests without an
// Origin header (server-to-server, curl) are allowed: they cannot ride on
// a visitor's browser, and every other rule still applies to them.
function isAllowedOrigin(req, allowedOrigins) {
  const origin = req.headers && req.headers.origin;
  if (origin === undefined || origin === "") return true;
  return allowedOrigins.has(origin);
}

module.exports = {
  generateReleaseToken,
  hashToken,
  isReleaseToken,
  isUuid,
  getClientIp,
  hashIp,
  isAllowedOrigin,
};
