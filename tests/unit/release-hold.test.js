"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { createReleaseHoldHandler } = require("../../api/release-hold");
const { invoke, postJson, SITE } = require("../helpers/http");
const { createFakeStripe } = require("../helpers/fake-stripe");

const BOOKING_ID = "3f2b9c1e-8d4a-4b6f-9a1c-2e5d7f8a9b0c";
const TOKEN = crypto.randomBytes(32).toString("base64url");
const TOKEN_HASH = crypto.createHash("sha256").update(TOKEN).digest("hex");

function fakeRepository(hold, overrides = {}) {
  const calls = { find: [], release: [] };
  return {
    calls,
    async findHoldForRelease(id, hash) {
      calls.find.push([id, hash]);
      return hold && id === hold.id && hash === TOKEN_HASH ? hold : null;
    },
    async releaseHold(id, reason, proof) {
      calls.release.push([id, reason, proof]);
      return true;
    },
    ...overrides,
  };
}

function setup({ hold, repo, stripe = createFakeStripe() } = {}) {
  repo = repo || fakeRepository(hold);
  const handler = createReleaseHoldHandler({
    getRepository: () => repo,
    getStripe: () => stripe,
    getSite: () => ({ siteUrl: SITE, allowedOrigins: new Set([SITE]) }),
  });
  return { handler, repo, stripe };
}

const pending = (sessionId = "cs_test_open") => ({ id: BOOKING_ID, status: "pending_payment", stripe_checkout_session_id: sessionId });

test("method, origin, content type and input are validated", async () => {
  const { handler, repo } = setup({ hold: pending() });
  assert.equal((await invoke(handler, { method: "GET" })).status, 405);
  assert.equal((await postJson(handler, { bookingId: BOOKING_ID, releaseToken: TOKEN }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await invoke(handler, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" })).status, 415);
  for (const body of [{}, { bookingId: "123", releaseToken: TOKEN }, { bookingId: BOOKING_ID, releaseToken: "short" }, { bookingId: BOOKING_ID, releaseToken: TOKEN + "!" }]) {
    assert.equal((await postJson(handler, body)).status, 400, JSON.stringify(body));
  }
  assert.equal(repo.calls.release.length, 0);
});

test("unknown hold or wrong token: nothing released, nothing revealed", async () => {
  const { handler, repo, stripe } = setup({ hold: pending() });
  const wrong = crypto.randomBytes(32).toString("base64url");
  const r = await postJson(handler, { bookingId: BOOKING_ID, releaseToken: wrong });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { released: false });
  assert.equal(repo.calls.find[0][1], crypto.createHash("sha256").update(wrong).digest("hex"), "only the hash is used");
  assert.equal(stripe.calls.expire.length, 0);
  assert.equal(repo.calls.release.length, 0);
});

test("non-pending booking (confirmed, expired…) is never released", async () => {
  for (const status of ["confirmed", "needs_review", "expired", "cancelled", "refunded"]) {
    const { handler, repo, stripe } = setup({ hold: { ...pending(), status } });
    const r = await postJson(handler, { bookingId: BOOKING_ID, releaseToken: TOKEN });
    assert.deepEqual(r.json, { released: false }, status);
    assert.equal(stripe.calls.expire.length, 0);
    assert.equal(repo.calls.release.length, 0);
  }
});

test("pending hold: Stripe session expired FIRST, then slot released", async () => {
  const order = [];
  const stripe = createFakeStripe({ expire: async (id) => { order.push("stripe"); return { id, status: "expired" }; } });
  const repo = fakeRepository(pending(), { async releaseHold(id, reason, proof) { order.push("db"); this.calls.release.push([id, reason, proof]); return true; } });
  const { handler } = setup({ repo, stripe });
  const r = await postJson(handler, { bookingId: BOOKING_ID, releaseToken: TOKEN });
  assert.deepEqual(r.json, { released: true });
  assert.deepEqual(order, ["stripe", "db"]);
  assert.deepEqual(stripe.calls.expire, ["cs_test_open"]);
  assert.deepEqual(repo.calls.release[0], [BOOKING_ID, "cancelled", { releaseTokenHash: TOKEN_HASH }]);
});

test("pending hold without a Stripe session is released directly", async () => {
  const { handler, repo, stripe } = setup({ hold: pending(null) });
  const r = await postJson(handler, { bookingId: BOOKING_ID, releaseToken: TOKEN });
  assert.deepEqual(r.json, { released: true });
  assert.equal(stripe.calls.expire.length, 0);
  assert.equal(repo.calls.release.length, 1);
});

test("already paid on Stripe: the booking is NOT released", async () => {
  const stripe = createFakeStripe({
    expire: async () => { throw Object.assign(new Error("not expirable"), { type: "StripeInvalidRequestError" }); },
    retrieve: async (id) => ({ id, status: "complete" }),
  });
  const { handler, repo } = setup({ hold: pending(), stripe });
  const r = await postJson(handler, { bookingId: BOOKING_ID, releaseToken: TOKEN });
  assert.deepEqual(r.json, { released: false });
  assert.equal(repo.calls.release.length, 0);
});

test("Stripe session already expired: slot released", async () => {
  const stripe = createFakeStripe({
    expire: async () => { throw new Error("not expirable"); },
    retrieve: async (id) => ({ id, status: "expired" }),
  });
  const { handler, repo } = setup({ hold: pending(), stripe });
  const r = await postJson(handler, { bookingId: BOOKING_ID, releaseToken: TOKEN });
  assert.deepEqual(r.json, { released: true });
  assert.equal(repo.calls.release.length, 1);
});

test("Stripe unreachable: 503 and the slot is kept (it expires by itself)", async () => {
  const stripe = createFakeStripe({
    expire: async () => { throw Object.assign(new Error("connect ETIMEDOUT"), { type: "StripeConnectionError" }); },
    retrieve: async () => { throw Object.assign(new Error("connect ETIMEDOUT"), { type: "StripeConnectionError" }); },
  });
  const { handler, repo } = setup({ hold: pending(), stripe });
  const r = await postJson(handler, { bookingId: BOOKING_ID, releaseToken: TOKEN });
  assert.equal(r.status, 503);
  assert.doesNotMatch(r.body, /ETIMEDOUT/);
  assert.equal(repo.calls.release.length, 0);
});

test("Stripe says the session is still open after expire fails: slot kept", async () => {
  const stripe = createFakeStripe({
    expire: async () => { throw new Error("rate limited"); },
    retrieve: async (id) => ({ id, status: "open" }),
  });
  const { handler, repo } = setup({ hold: pending(), stripe });
  const r = await postJson(handler, { bookingId: BOOKING_ID, releaseToken: TOKEN });
  assert.equal(r.status, 503);
  assert.equal(repo.calls.release.length, 0);
});
