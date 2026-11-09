"use strict";

// Runs the real Stripe SDK with an intercepted HTTP layer: nothing leaves
// the machine, but we see exactly what Stripe would receive.

const test = require("node:test");
const assert = require("node:assert/strict");
const Stripe = require("stripe");
const { createStripeClient, STRIPE_API_VERSION } = require("../../api/_lib/stripe");
const { createCheckoutHandler } = require("../../api/create-checkout-session");
const { createReleaseHoldHandler } = require("../../api/release-hold");
const { postJson, SITE } = require("../helpers/http");

const BOOKING_ID = "3f2b9c1e-8d4a-4b6f-9a1c-2e5d7f8a9b0c";

function interceptedStripe(responder) {
  const requests = [];
  const fakeFetch = async (url, init) => {
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const request = { url: String(url), method: init.method, headers, body: new URLSearchParams(init.body || "") };
    requests.push(request);
    const { status = 200, json } = responder(request);
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json", "request-id": "req_test" } });
  };
  const stripe = createStripeClient("sk_test_contract_only", {
    httpClient: Stripe.createFetchHttpClient(fakeFetch),
    maxNetworkRetries: 0,
  });
  return { stripe, requests };
}

test("checkout: the Stripe API receives the expected request", async () => {
  const { stripe, requests } = interceptedStripe(() => ({
    json: { id: "cs_test_contract", object: "checkout.session", url: "https://checkout.stripe.com/c/pay/cs_test_contract", status: "open" },
  }));
  const now = Date.now();
  const repo = {
    async createHold() {
      return {
        booking_id: BOOKING_ID, reference: "MRK-0000ABCD", package_id: "starter", package_name: "Recording Starter",
        duration_minutes: 120, starts_at: "2026-12-03T09:00:00Z", ends_at: "2026-12-03T11:00:00Z",
        hold_expires_at: new Date(now + 35 * 60000).toISOString(), checkout_expires_at: new Date(now + 30 * 60000).toISOString(),
        price_cents: 12000, currency: "eur", timezone: "Europe/Madrid",
      };
    },
    async attachCheckoutSession() { return true; },
    async releaseHold() { return true; },
  };
  const handler = createCheckoutHandler({
    getRepository: () => repo, getStripe: () => stripe,
    getSite: () => ({ siteUrl: SITE, allowedOrigins: new Set([SITE]) }),
    getSalt: () => "s".repeat(40), now: () => now,
  });

  const r = await postJson(handler, { packageId: "starter", date: "2026-12-03", startTime: "10:00" });
  assert.equal(r.status, 200);
  assert.equal(r.json.url, "https://checkout.stripe.com/c/pay/cs_test_contract");

  assert.equal(requests.length, 1);
  const req = requests[0];
  assert.equal(req.method, "POST");
  assert.equal(req.url, "https://api.stripe.com/v1/checkout/sessions");
  assert.equal(req.headers["stripe-version"], STRIPE_API_VERSION);
  assert.equal(req.headers["idempotency-key"], `checkout-${BOOKING_ID}`);
  assert.equal(req.headers.authorization, "Bearer sk_test_contract_only");

  const b = req.body;
  assert.equal(b.get("mode"), "payment");
  assert.equal(b.get("payment_method_types[0]"), "card");
  assert.equal(b.get("payment_method_types[1]"), "link");
  assert.equal(b.get("line_items[0][quantity]"), "1");
  assert.equal(b.get("line_items[0][price_data][currency]"), "eur");
  assert.equal(b.get("line_items[0][price_data][unit_amount]"), "12000");
  assert.equal(b.get("line_items[0][price_data][product_data][name]"), "MRKLL Recording Starter");
  assert.equal(b.get("client_reference_id"), BOOKING_ID);
  assert.equal(b.get("metadata[booking_id]"), BOOKING_ID);
  assert.equal(b.get("metadata[packageType]"), "starter");
  assert.equal(b.get("metadata[date]"), "3 December 2026");
  assert.equal(b.get("metadata[time]"), "10:00");
  assert.equal(b.get("payment_intent_data[metadata][booking_id]"), BOOKING_ID);
  assert.equal(b.get("phone_number_collection[enabled]"), "true");
  assert.equal(b.get("success_url"), `${SITE}/booking-success.html?session_id={CHECKOUT_SESSION_ID}`);
  assert.equal(b.get("cancel_url"), `${SITE}/checkout.html?package=starter&cancelled=1`);
  const expiresAt = Number(b.get("expires_at"));
  assert.ok(expiresAt >= Math.floor(now / 1000) + 1800 && expiresAt <= Math.floor(now / 1000) + 1860);
  assert.equal(b.get("customer_email"), null, "no personal data is pre-filled");
});

test("release: the Stripe API receives an expire call for the session", async () => {
  const { stripe, requests } = interceptedStripe((req) => ({
    json: { id: "cs_test_contract", object: "checkout.session", status: req.url.endsWith("/expire") ? "expired" : "open" },
  }));
  const repo = {
    async findHoldForRelease() { return { id: BOOKING_ID, status: "pending_payment", stripe_checkout_session_id: "cs_test_contract" }; },
    async releaseHold() { return true; },
  };
  const handler = createReleaseHoldHandler({
    getRepository: () => repo, getStripe: () => stripe,
    getSite: () => ({ siteUrl: SITE, allowedOrigins: new Set([SITE]) }),
  });
  const r = await postJson(handler, { bookingId: BOOKING_ID, releaseToken: "A".repeat(43) });
  assert.deepEqual(r.json, { released: true });
  assert.equal(requests[0].url, "https://api.stripe.com/v1/checkout/sessions/cs_test_contract/expire");
  assert.equal(requests[0].method, "POST");
});

test("release: Stripe refuses to expire a paid session -> booking kept", async () => {
  let call = 0;
  const { stripe } = interceptedStripe(() => {
    call += 1;
    if (call === 1) {
      return { status: 400, json: { error: { type: "invalid_request_error", message: "Only Checkout Sessions with a status in [\"open\"] can be expired." } } };
    }
    return { json: { id: "cs_test_contract", object: "checkout.session", status: "complete" } };
  });
  let released = false;
  const repo = {
    async findHoldForRelease() { return { id: BOOKING_ID, status: "pending_payment", stripe_checkout_session_id: "cs_test_contract" }; },
    async releaseHold() { released = true; return true; },
  };
  const handler = createReleaseHoldHandler({
    getRepository: () => repo, getStripe: () => stripe,
    getSite: () => ({ siteUrl: SITE, allowedOrigins: new Set([SITE]) }),
  });
  const r = await postJson(handler, { bookingId: BOOKING_ID, releaseToken: "A".repeat(43) });
  assert.deepEqual(r.json, { released: false });
  assert.equal(released, false);
});
