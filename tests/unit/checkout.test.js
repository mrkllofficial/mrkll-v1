"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { createCheckoutHandler, buildCheckoutSessionParams } = require("../../api/create-checkout-session");
const { ConfigError } = require("../../api/_lib/config");
const { invoke, postJson, SITE } = require("../helpers/http");
const { createFakeStripe } = require("../helpers/fake-stripe");

const NOW = Date.parse("2026-11-09T10:00:00Z");
const SALT = "test-salt-0123456789abcdef0123456789abcdef";
const BOOKING_ID = "3f2b9c1e-8d4a-4b6f-9a1c-2e5d7f8a9b0c";

function holdRow(overrides = {}) {
  return {
    booking_id: BOOKING_ID,
    reference: "MRK-1A2B3C4D",
    package_id: "pro",
    package_name: "Recording Pro",
    duration_minutes: 240,
    starts_at: "2026-12-03T09:00:00+00:00", // 10:00 in Madrid (winter)
    ends_at: "2026-12-03T13:00:00+00:00",
    hold_expires_at: new Date(NOW + 35 * 60000).toISOString(),
    checkout_expires_at: new Date(NOW + 30 * 60000).toISOString(),
    price_cents: 20000,
    currency: "eur",
    timezone: "Europe/Madrid",
    ...overrides,
  };
}

function fakeRepository(overrides = {}) {
  const calls = { createHold: [], attach: [], release: [] };
  return {
    calls,
    async createHold(args) {
      calls.createHold.push(args);
      return holdRow();
    },
    async attachCheckoutSession(id, sessionId) {
      calls.attach.push([id, sessionId]);
      return true;
    },
    async releaseHold(id, reason, proof) {
      calls.release.push([id, reason, proof]);
      return true;
    },
    ...overrides,
  };
}

function setup({ repo = fakeRepository(), stripe = createFakeStripe(), site, salt } = {}) {
  const handler = createCheckoutHandler({
    getRepository: () => repo,
    getStripe: () => stripe,
    getSite: site || (() => ({ siteUrl: SITE, allowedOrigins: new Set([SITE]) })),
    getSalt: salt || (() => SALT),
    now: () => NOW,
  });
  return { handler, repo, stripe };
}

const VALID = { packageId: "pro", date: "2026-12-03", startTime: "10:00" };

test("only POST is allowed", async () => {
  const { handler } = setup();
  const r = await invoke(handler, { method: "GET" });
  assert.equal(r.status, 405);
  assert.equal(r.headers.allow, "POST");
});

test("missing configuration: 500 without details, nothing created", async () => {
  const { handler, repo, stripe } = setup({ salt: () => { throw new ConfigError("Missing environment variable BOOKING_IP_SALT"); } });
  const r = await postJson(handler, VALID);
  assert.equal(r.status, 500);
  assert.equal(r.json.error.code, "CONFIG_ERROR");
  assert.doesNotMatch(r.body, /SALT|environment/);
  assert.equal(repo.calls.createHold.length, 0);
  assert.equal(stripe.calls.create.length, 0);
});

test("requests from another website are refused", async () => {
  const { handler, repo } = setup();
  const r = await postJson(handler, VALID, { origin: "https://evil.example" });
  assert.equal(r.status, 403);
  assert.equal(r.json.error.code, "ORIGIN_NOT_ALLOWED");
  assert.equal(repo.calls.createHold.length, 0);
});

test("requests without Origin (server-side) are accepted", async () => {
  const { handler } = setup();
  const r = await invoke(handler, {
    method: "POST", headers: { "content-type": "application/json" }, body: VALID,
  });
  assert.equal(r.status, 200);
});

test("only JSON bodies are accepted", async () => {
  const { handler } = setup();
  const form = await invoke(handler, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: SITE }, body: "packageId=pro",
  });
  assert.equal(form.status, 415);
  const bad = await invoke(handler, { method: "POST", headers: { "content-type": "application/json" }, stream: "{not json" });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, "INVALID_JSON");
  const arr = await invoke(handler, { method: "POST", headers: { "content-type": "application/json" }, stream: "[1,2]" });
  assert.equal(arr.status, 400);
  const big = await invoke(handler, { method: "POST", headers: { "content-type": "application/json" }, stream: JSON.stringify({ x: "a".repeat(5000) }) });
  assert.equal(big.status, 413);
});

test("raw JSON stream bodies are parsed", async () => {
  const { handler } = setup();
  const r = await invoke(handler, { method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, stream: JSON.stringify(VALID) });
  assert.equal(r.status, 200);
});

test("invalid fields are rejected before touching the database", async () => {
  const cases = [
    {},
    { ...VALID, packageId: "" },
    { ...VALID, packageId: "pro'; drop table bookings;--" },
    { ...VALID, date: "3 December 2026" },
    { ...VALID, date: "2027-02-30" },
    { ...VALID, startTime: "25:00" },
    { ...VALID, startTime: "10" },
    { ...VALID, date: ["2026-12-03"] },
  ];
  for (const body of cases) {
    const { handler, repo } = setup();
    const r = await postJson(handler, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.error.code, "INVALID_INPUT");
    assert.equal(repo.calls.createHold.length, 0);
  }
});

test("legacy field name packageType is accepted", async () => {
  const { handler, repo } = setup();
  const r = await postJson(handler, { packageType: "legend", date: "2026-12-03", startTime: "10:00" });
  assert.equal(r.status, 200);
  assert.equal(repo.calls.createHold[0].packageId, "legend");
});

test("success: hold, Stripe session with database price, link, response", async () => {
  const { handler, repo, stripe } = setup();
  const r = await postJson(handler, VALID, { ip: "198.51.100.7" });
  assert.equal(r.status, 200);

  // hold request
  const hold = repo.calls.createHold[0];
  assert.deepEqual({ packageId: hold.packageId, date: hold.date, startTime: hold.startTime }, VALID);
  assert.match(hold.ipHash, /^[0-9a-f]{64}$/);
  assert.equal(hold.ipHash, crypto.createHmac("sha256", SALT).update("198.51.100.7").digest("hex"));
  assert.equal(hold.releaseTokenHash, crypto.createHash("sha256").update(r.json.releaseToken).digest("hex"));

  // Stripe parameters
  const { params, options } = stripe.calls.create[0];
  assert.equal(options.idempotencyKey, `checkout-${BOOKING_ID}`);
  assert.equal(params.mode, "payment");
  assert.deepEqual(params.payment_method_types, ["card", "link"]);
  assert.equal(params.line_items[0].price_data.unit_amount, 20000);
  assert.equal(params.line_items[0].price_data.currency, "eur");
  assert.equal(params.client_reference_id, BOOKING_ID);
  assert.equal(params.metadata.booking_id, BOOKING_ID);
  assert.equal(params.payment_intent_data.metadata.booking_id, BOOKING_ID);
  assert.equal(params.success_url, `${SITE}/booking-success.html?session_id={CHECKOUT_SESSION_ID}`);
  assert.equal(params.cancel_url, `${SITE}/checkout.html?package=pro&cancelled=1`);
  assert.ok(params.expires_at >= NOW / 1000 + 30 * 60, "Stripe minimum of 30 minutes");
  assert.ok(params.expires_at <= Date.parse(holdRow().hold_expires_at) / 1000 - 120, "ends before the hold");

  // secrets never leave the server
  const sent = JSON.stringify(params);
  assert.doesNotMatch(sent, /198\.51\.100\.7/);
  assert.ok(!sent.includes(r.json.releaseToken));
  assert.ok(!sent.includes(hold.releaseTokenHash));

  // link + response
  assert.deepEqual(repo.calls.attach[0], [BOOKING_ID, "cs_test_fake_1"]);
  assert.equal(r.json.url, "https://checkout.stripe.com/c/pay/cs_test_fake_1");
  assert.equal(r.json.bookingId, BOOKING_ID);
  assert.equal(r.json.reference, "MRK-1A2B3C4D");
  assert.match(r.json.releaseToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(r.json.holdExpiresAt, holdRow().hold_expires_at);
  assert.equal(r.headers["cache-control"], "no-store");
  assert.equal(repo.calls.release.length, 0);
});

test("each request gets a different release token", async () => {
  const { handler } = setup();
  const a = await postJson(handler, VALID);
  const b = await postJson(handler, VALID);
  assert.notEqual(a.json.releaseToken, b.json.releaseToken);
});

test("database business errors are reported, Stripe is never called", async () => {
  const expected = { SLOT_UNAVAILABLE: 409, SLOT_NOT_BOOKABLE: 409, TOO_MANY_HOLDS: 429, PACKAGE_NOT_FOUND: 404 };
  for (const [code, status] of Object.entries(expected)) {
    const repo = fakeRepository({
      async createHold() {
        const e = new Error(code);
        e.code = "P0001";
        throw e;
      },
    });
    const { handler, stripe } = setup({ repo });
    const r = await postJson(handler, VALID);
    assert.equal(r.status, status, code);
    assert.equal(r.json.error.code, code);
    assert.equal(stripe.calls.create.length, 0);
  }
});

test("unexpected database error: 503 without internals", async () => {
  const repo = fakeRepository({
    async createHold() {
      throw Object.assign(new Error("permission denied for table bookings"), { code: "42501" });
    },
  });
  const { handler, stripe } = setup({ repo });
  const r = await postJson(handler, VALID);
  assert.equal(r.status, 503);
  assert.doesNotMatch(r.body, /permission|bookings/);
  assert.equal(stripe.calls.create.length, 0);
});

test("Stripe failure releases the hold immediately (502)", async () => {
  const stripe = createFakeStripe({
    create() {
      throw Object.assign(new Error("Invalid API Key provided: sk_test_****abcd"), { type: "StripeAuthenticationError" });
    },
  });
  const { handler, repo } = setup({ stripe });
  const r = await postJson(handler, VALID);
  assert.equal(r.status, 502);
  assert.equal(r.json.error.code, "PAYMENT_PROVIDER_ERROR");
  assert.doesNotMatch(r.body, /sk_test|API Key/);
  assert.equal(repo.calls.release.length, 1);
  const [id, reason, proof] = repo.calls.release[0];
  assert.equal(id, BOOKING_ID);
  assert.equal(reason, "cancelled");
  assert.equal(proof.releaseTokenHash, repo.calls.createHold[0].releaseTokenHash);
});

test("if the session cannot be linked, it is expired and the hold released", async () => {
  for (const attach of [async () => false, async () => { throw new Error("db down"); }]) {
    const repo = fakeRepository({ attachCheckoutSession: attach });
    const { handler, stripe } = setup({ repo });
    const r = await postJson(handler, VALID);
    assert.equal(r.status, 503);
    assert.deepEqual(stripe.calls.expire, ["cs_test_fake_1"]);
    assert.equal(repo.calls.release.length, 1);
    assert.equal(r.json.url, undefined, "no checkout URL returned");
  }
});

test("Stripe parameters use Barcelona time, also in summer", () => {
  const winter = buildCheckoutSessionParams({ hold: holdRow(), siteUrl: SITE, nowMs: NOW });
  assert.match(winter.line_items[0].price_data.product_data.description, /^Thursday 3 December 2026 · 10:00–14:00 \(Barcelona time\) · Ref\. MRK-1A2B3C4D$/);
  assert.equal(winter.metadata.time, "10:00");
  assert.equal(winter.metadata.date, "3 December 2026");

  const summer = buildCheckoutSessionParams({
    hold: holdRow({ package_id: "legend", package_name: "Recording Legend", starts_at: "2027-06-23T13:00:00Z", ends_at: "2027-06-23T19:00:00Z", price_cents: 28000 }),
    siteUrl: SITE,
    nowMs: NOW,
  });
  assert.match(summer.line_items[0].price_data.product_data.description, /^Wednesday 23 June 2027 · 15:00–21:00/);
  assert.equal(summer.line_items[0].price_data.unit_amount, 28000);
  assert.equal(summer.cancel_url, `${SITE}/checkout.html?package=legend&cancelled=1`);
});

test("checkout can never outlive the slot hold", () => {
  assert.throws(() => buildCheckoutSessionParams({
    hold: holdRow({ hold_expires_at: new Date(NOW + 32 * 60000).toISOString() }), siteUrl: SITE, nowMs: NOW,
  }), /outlive/);
});
