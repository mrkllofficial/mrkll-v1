"use strict";

// Builds Stripe events and signs them exactly like Stripe does, using the
// SDK's own test helper. No network access.

const crypto = require("crypto");
const Stripe = require("stripe");
const { createStripeClient } = require("../../api/_lib/stripe");
const { invoke } = require("./http");

const WEBHOOK_SECRET = "whsec_test_mrkll_local_only";

function makeEvent(type, object, { id, livemode = false, created } = {}) {
  return {
    id: id || `evt_test_${crypto.randomBytes(8).toString("hex")}`,
    object: "event",
    api_version: "2023-08-16",
    created: created || Math.floor(Date.now() / 1000),
    livemode,
    type,
    data: { object },
  };
}

function checkoutSession({ id, bookingId, paymentIntent = `pi_${crypto.randomBytes(6).toString("hex")}`, amount = 20000,
  currency = "eur", paymentStatus = "paid", email = "ana@example.com", name = "Ana García", phone = "+34 600 000 000", metadata } = {}) {
  return {
    id: id || `cs_test_${crypto.randomBytes(6).toString("hex")}`,
    object: "checkout.session",
    mode: "payment",
    status: paymentStatus === "paid" ? "complete" : "open",
    payment_status: paymentStatus,
    amount_total: amount,
    currency,
    client_reference_id: bookingId || null,
    payment_intent: paymentIntent,
    customer_details: { email, name, phone },
    metadata: metadata || (bookingId ? { booking_id: bookingId, reference: "MRK-TEST" } : {}),
  };
}

function charge({ paymentIntent, amount = 20000, refunded = amount }) {
  return {
    id: `ch_${crypto.randomBytes(6).toString("hex")}`,
    object: "charge",
    payment_intent: paymentIntent,
    amount,
    amount_refunded: refunded,
    refunded: refunded >= amount,
  };
}

function sign(payload, secret = WEBHOOK_SECRET, timestamp) {
  return Stripe("sk_test_signing_only").webhooks.generateTestHeaderString({ payload, secret, timestamp });
}

// Posts an event to the handler as a raw stream, like Stripe would.
function deliver(handler, event, { secret = WEBHOOK_SECRET, tamper = false, signature } = {}) {
  const payload = JSON.stringify(event);
  const header = signature !== undefined ? signature : sign(payload, secret);
  return invoke(handler, {
    method: "POST",
    headers: { "content-type": "application/json", ...(header ? { "stripe-signature": header } : {}) },
    stream: tamper ? payload.replace("paid", "unpaid") : payload,
  });
}

// Real SDK (for constructEvent) with intercepted HTTP for refunds.
function stripeForWebhook({ refund } = {}) {
  const refunds = [];
  const fakeFetch = async (url, init) => {
    const headers = Object.fromEntries([...new Headers(init.headers || {})]); // plain object (stripe@13) or Headers (newer SDKs)
    const body = new URLSearchParams(init.body || "");
    const request = { url: String(url), idempotencyKey: headers["idempotency-key"], paymentIntent: body.get("payment_intent"), body };
    refunds.push(request);
    const { status = 200, json } = refund ? refund(request) : { json: { id: `re_${refunds.length}`, object: "refund", status: "succeeded" } };
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  };
  const stripe = createStripeClient("sk_test_webhook_local_only", {
    httpClient: Stripe.createFetchHttpClient(fakeFetch),
    maxNetworkRetries: 0,
  });
  return { stripe, refunds };
}

// Records e-mails; can be told to fail.
function fakeMailer() {
  const sent = [];
  let failure = null;
  const send = async (msg) => {
    if (failure) {
      const f = failure;
      if (f.times !== undefined) {
        f.times -= 1;
        if (f.times <= 0) failure = null;
      }
      throw f.error;
    }
    sent.push(msg);
    return { messageId: `<m${sent.length}@test>` };
  };
  return {
    sent,
    send,
    failWith(error, times) { failure = { error, times }; },
    kinds: () => sent.map((m) => m.tags[1]),
  };
}

const EMAIL_CONFIG = {
  apiKey: "xkeysib-test-only",
  sender: { email: "studios@mrkll.com", name: "MRKLL Studios" },
  studio: { email: "studios@mrkll.com", name: "MRKLL Studios" },
};

module.exports = {
  WEBHOOK_SECRET, EMAIL_CONFIG, makeEvent, checkoutSession, charge, sign, deliver, stripeForWebhook, fakeMailer,
};
