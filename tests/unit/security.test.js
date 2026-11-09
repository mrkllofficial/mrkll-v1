"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const security = require("../../api/_lib/security");
const { getSiteConfig, getStripeConfig, getIpSalt, ConfigError } = require("../../api/_lib/config");
const { readJsonBody } = require("../../api/_lib/body");

test("release tokens: 256-bit random, URL-safe, stored only as SHA-256", () => {
  const tokens = new Set(Array.from({ length: 200 }, () => security.generateReleaseToken()));
  assert.equal(tokens.size, 200);
  for (const t of tokens) assert.ok(security.isReleaseToken(t));
  const t = [...tokens][0];
  assert.match(security.hashToken(t), /^[0-9a-f]{64}$/);
  assert.notEqual(security.hashToken(t), t);
  assert.equal(security.isReleaseToken("abc"), false);
  assert.equal(security.isReleaseToken(42), false);
});

test("uuid validation", () => {
  assert.ok(security.isUuid("3f2b9c1e-8d4a-4b6f-9a1c-2e5d7f8a9b0c"));
  assert.equal(security.isUuid("3f2b9c1e8d4a4b6f9a1c2e5d7f8a9b0c"), false);
  assert.equal(security.isUuid("' or 1=1 --"), false);
  assert.equal(security.isUuid(null), false);
});

test("client IP: Vercel headers first, never stored in clear", () => {
  assert.equal(security.getClientIp({ headers: { "x-real-ip": "203.0.113.5", "x-forwarded-for": "1.1.1.1" } }), "203.0.113.5");
  assert.equal(security.getClientIp({ headers: { "x-forwarded-for": "198.51.100.1, 10.0.0.1" } }), "198.51.100.1");
  assert.equal(security.getClientIp({ headers: {}, socket: { remoteAddress: "::1" } }), "::1");
  const salt = "x".repeat(32);
  const h = security.hashIp("203.0.113.5", salt);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, security.hashIp("203.0.113.5", salt));
  assert.notEqual(h, security.hashIp("203.0.113.5", "y".repeat(32)), "depends on the secret salt");
});

test("origin check", () => {
  const allowed = new Set(["https://mrkll.com"]);
  assert.ok(security.isAllowedOrigin({ headers: { origin: "https://mrkll.com" } }, allowed));
  assert.ok(security.isAllowedOrigin({ headers: {} }, allowed));
  assert.equal(security.isAllowedOrigin({ headers: { origin: "https://mrkll.com.evil.example" } }, allowed), false);
  assert.equal(security.isAllowedOrigin({ headers: { origin: "http://mrkll.com" } }, allowed), false);
  assert.equal(security.isAllowedOrigin({ headers: { origin: "null" } }, allowed), false);
});

test("SITE_URL: https required, Vercel preview URLs allowed as origins", () => {
  assert.throws(() => getSiteConfig({}), ConfigError);
  assert.throws(() => getSiteConfig({ SITE_URL: "http://mrkll.com" }), /https/);
  assert.equal(getSiteConfig({ SITE_URL: "http://localhost:3000" }).siteUrl, "http://localhost:3000");
  const c = getSiteConfig({ SITE_URL: "https://mrkll.com/", VERCEL_URL: "mrkll-abc.vercel.app", VERCEL_BRANCH_URL: "mrkll-git-x.vercel.app" });
  assert.equal(c.siteUrl, "https://mrkll.com");
  assert.deepEqual([...c.allowedOrigins], ["https://mrkll.com", "https://mrkll-abc.vercel.app", "https://mrkll-git-x.vercel.app"]);
});

test("Stripe key: test keys accepted, live keys refused unless explicitly enabled", () => {
  assert.throws(() => getStripeConfig({}), ConfigError);
  assert.throws(() => getStripeConfig({ STRIPE_SECRET_KEY: "pk_test_123" }), /not a Stripe secret/);
  assert.equal(getStripeConfig({ STRIPE_SECRET_KEY: "sk_test_123" }).livemode, false);
  assert.equal(getStripeConfig({ STRIPE_SECRET_KEY: "rk_test_123" }).livemode, false);
  assert.throws(() => getStripeConfig({ STRIPE_SECRET_KEY: "sk_live_123" }), /live payments are not enabled/);
  assert.throws(() => getStripeConfig({ STRIPE_SECRET_KEY: "rk_live_123", STRIPE_LIVE_MODE: "yes" }), /not enabled/);
  assert.equal(getStripeConfig({ STRIPE_SECRET_KEY: "sk_live_123", STRIPE_LIVE_MODE: "enabled" }).livemode, true);
});

test("IP salt must be long", () => {
  assert.throws(() => getIpSalt({}), ConfigError);
  assert.throws(() => getIpSalt({ BOOKING_IP_SALT: "short" }), /32/);
  assert.equal(getIpSalt({ BOOKING_IP_SALT: "z".repeat(40) }).length, 40);
});

test("JSON body reader", async () => {
  const req = (headers, body) => ({ headers, body, on() {} });
  assert.deepEqual(await readJsonBody(req({ "content-type": "application/json" }, { a: 1 })), { a: 1 });
  assert.deepEqual(await readJsonBody(req({ "content-type": "application/json" }, '{"a":2}')), { a: 2 });
  await assert.rejects(readJsonBody(req({ "content-type": "text/plain" }, "{}")), (e) => e.status === 415);
  await assert.rejects(readJsonBody(req({}, {})), (e) => e.status === 415);
  await assert.rejects(readJsonBody(req({ "content-type": "application/json" }, "nope")), (e) => e.status === 400);
  await assert.rejects(readJsonBody(req({ "content-type": "application/json" }, "null")), (e) => e.status === 400);
  const throwing = { headers: { "content-type": "application/json" }, on() {}, get body() { throw new SyntaxError("bad"); } };
  await assert.rejects(readJsonBody(throwing), (e) => e.status === 400 && e.code === "INVALID_JSON");
});
