"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const webhookModule = require("../../api/stripe-webhook");
const { createWebhookHandler } = webhookModule;
const { ConfigError } = require("../../api/_lib/config");
const { EmailError } = require("../../api/_lib/brevo");
const { invoke } = require("../helpers/http");
const ev = require("../helpers/stripe-events");

const BOOKING = "3f2b9c1e-8d4a-4b6f-9a1c-2e5d7f8a9b0c";

const details = (o = {}) => ({
  id: BOOKING, reference: "MRK-1A2B3C4D", status: "confirmed", package_id: "pro", package_name: "Recording Pro",
  duration_minutes: 240, starts_at: "2026-12-03T09:00:00Z", ends_at: "2026-12-03T13:00:00Z", price_cents: 20000,
  amount_paid_cents: 20000, currency: "eur", customer_name: "Ana García", customer_email: "ana@example.com",
  customer_phone: "+34 600", stripe_checkout_session_id: "cs_test_1", stripe_payment_intent_id: "pi_1",
  conflict_at: null, timezone: "Europe/Madrid", ...o,
});

// In-memory repository with the same contract as the database functions.
function fakeRepo({ outcome = "confirmed", booking = details(), refund = null, eventState = "new" } = {}) {
  const calls = { begin: [], finish: [], confirm: [], release: [], refund: [], claim: [], complete: [] };
  const claimed = new Map();
  return {
    calls,
    async beginStripeEvent(...a) { calls.begin.push(a); return eventState; },
    async finishStripeEvent(id) { calls.finish.push(id); },
    async confirmBooking(a) { calls.confirm.push(a); return outcome; },
    async getBookingDetails() { return booking; },
    async releaseHold(...a) { calls.release.push(a); return true; },
    async recordRefund(a) { calls.refund.push(a); return refund; },
    async claimNotification(key) {
      calls.claim.push(key);
      if (claimed.get(key) === "sent" || claimed.get(key) === "sending") return false;
      claimed.set(key, "sending");
      return true;
    },
    async completeNotification(key, outcomeValue) { calls.complete.push([key, outcomeValue]); claimed.set(key, outcomeValue); return true; },
  };
}

function setup({ repo = fakeRepo(), stripeOpts, livemode = false, config } = {}) {
  const { stripe, refunds } = ev.stripeForWebhook(stripeOpts);
  const mailer = ev.fakeMailer();
  const handler = createWebhookHandler({
    getRepository: () => repo,
    getStripe: () => stripe,
    getSecret: config || (() => ev.WEBHOOK_SECRET),
    getEmail: () => ev.EMAIL_CONFIG,
    getLivemode: () => livemode,
    sendEmail: mailer.send,
  });
  return { handler, repo, mailer, refunds };
}

const paid = (o = {}) => ev.makeEvent("checkout.session.completed", ev.checkoutSession({ id: "cs_test_1", bookingId: BOOKING, paymentIntent: "pi_1", ...o }));

test("module exports a handler and keeps raw-body config", () => {
  assert.equal(typeof webhookModule, "function");
  assert.deepEqual(webhookModule.config, { api: { bodyParser: false } });
});

test("only POST", async () => {
  const { handler } = setup();
  assert.equal((await invoke(handler, { method: "GET" })).status, 405);
});

test("missing configuration -> 500 so Stripe retries later", async () => {
  const { handler, repo } = setup({ config: () => { throw new ConfigError("Missing environment variable STRIPE_WEBHOOK_SECRET"); } });
  const r = await ev.deliver(handler, paid());
  assert.equal(r.status, 500);
  assert.doesNotMatch(r.body, /STRIPE_WEBHOOK_SECRET/);
  assert.equal(repo.calls.begin.length, 0);
});

test("signature: missing, wrong secret, tampered body, too old -> 400, nothing processed", async () => {
  const { handler, repo } = setup();
  const e = paid();
  assert.equal((await ev.deliver(handler, e, { signature: "" })).status, 400);
  assert.equal((await ev.deliver(handler, e, { secret: "whsec_someone_else" })).json.error.code, "INVALID_SIGNATURE");
  assert.equal((await ev.deliver(handler, e, { tamper: true })).status, 400);
  const old = ev.sign(JSON.stringify(e), ev.WEBHOOK_SECRET, Math.floor(Date.now() / 1000) - 3600);
  assert.equal((await ev.deliver(handler, e, { signature: old })).status, 400, "replay of an old signed event");
  assert.equal(repo.calls.begin.length, 0);
});

test("unhandled event types and the wrong mode are acknowledged and ignored", async () => {
  const { handler, repo } = setup();
  const r = await ev.deliver(handler, ev.makeEvent("customer.created", { id: "cus_1" }));
  assert.deepEqual(r.json, { received: true, ignored: true });
  const live = await ev.deliver(handler, ev.makeEvent("checkout.session.completed", ev.checkoutSession({ bookingId: BOOKING }), { livemode: true }));
  assert.equal(live.status, 200);
  assert.equal(live.json.ignored, true, "live event on a test deployment");
  assert.equal(repo.calls.begin.length, 0);
});

test("already processed event: no work, no e-mail", async () => {
  const { handler, repo, mailer } = setup({ repo: fakeRepo({ eventState: "processed" }) });
  const r = await ev.deliver(handler, paid());
  assert.equal(r.json.duplicate, true);
  assert.equal(repo.calls.confirm.length, 0);
  assert.equal(mailer.sent.length, 0);
});

test("paid session: booking confirmed, customer + studio e-mails, event finished", async () => {
  const { handler, repo, mailer } = setup();
  const e = paid();
  const r = await ev.deliver(handler, e);
  assert.equal(r.status, 200);
  assert.equal(r.json.result, "confirmed");
  assert.deepEqual(repo.calls.begin[0], [e.id, "checkout.session.completed", BOOKING]);
  assert.deepEqual(repo.calls.confirm[0], {
    bookingId: BOOKING, sessionId: "cs_test_1", paymentIntent: "pi_1", amountCents: 20000, currency: "eur",
    name: "Ana García", email: "ana@example.com", phone: "+34 600 000 000",
  });
  assert.deepEqual(mailer.kinds(), ["customer_confirmation", "studio_confirmation"]);
  assert.equal(mailer.sent[0].to.email, "ana@example.com");
  assert.deepEqual(mailer.sent[0].replyTo, ev.EMAIL_CONFIG.studio);
  assert.equal(mailer.sent[1].to.email, "studios@mrkll.com");
  assert.equal(mailer.sent[1].replyTo.email, "ana@example.com");
  assert.deepEqual(repo.calls.claim, [`${BOOKING}:customer_confirmation`, `${BOOKING}:studio_confirmation`]);
  assert.deepEqual(repo.calls.finish, [e.id]);
});

test("payment intent may arrive as an expanded object", async () => {
  const { handler, repo } = setup();
  await ev.deliver(handler, paid({ paymentIntent: { id: "pi_obj", object: "payment_intent" } }));
  assert.equal(repo.calls.confirm[0].paymentIntent, "pi_obj");
});

test("same repository, second delivery: e-mails are not sent twice", async () => {
  const repo = fakeRepo();
  const { handler, mailer } = setup({ repo });
  await ev.deliver(handler, paid());
  repo.confirmBooking = async () => "already_confirmed";
  await ev.deliver(handler, paid());
  assert.deepEqual(mailer.kinds(), ["customer_confirmation", "studio_confirmation"]);
});

test("unpaid (asynchronous) completion waits, async success confirms", async () => {
  const { handler, repo } = setup();
  const r = await ev.deliver(handler, paid({ paymentStatus: "unpaid" }));
  assert.equal(r.json.result, "awaiting_payment");
  assert.equal(repo.calls.confirm.length, 0);
  const ok = await ev.deliver(handler, ev.makeEvent("checkout.session.async_payment_succeeded", ev.checkoutSession({ id: "cs_test_1", bookingId: BOOKING })));
  assert.equal(ok.json.result, "confirmed");
});

test("needs_review: only the studio is alerted", async () => {
  const { handler, mailer } = setup({ repo: fakeRepo({ outcome: "needs_review", booking: details({ status: "needs_review", amount_paid_cents: 9900 }) }) });
  await ev.deliver(handler, paid({ amount: 9900 }));
  assert.deepEqual(mailer.kinds(), ["studio_needs_review"]);
});

test("conflict: automatic refund (idempotent) + conflict e-mails", async () => {
  const { handler, mailer, refunds } = setup({ repo: fakeRepo({ outcome: "conflict", booking: details({ status: "payment_conflict", conflict_at: new Date() }) }) });
  const r = await ev.deliver(handler, paid());
  assert.equal(r.json.result, "conflict");
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].url, "https://api.stripe.com/v1/refunds");
  assert.equal(refunds[0].paymentIntent, "pi_1");
  assert.equal(refunds[0].idempotencyKey, `conflict-refund-${BOOKING}`);
  assert.equal(refunds[0].body.get("metadata[reason]"), "slot_conflict");
  assert.deepEqual(mailer.kinds(), ["customer_conflict", "studio_conflict"]);
});

test("conflict: already refunded on Stripe is fine; other Stripe errors -> 500 and retry", async () => {
  const already = setup({
    repo: fakeRepo({ outcome: "conflict", booking: details({ status: "payment_conflict", conflict_at: new Date() }) }),
    stripeOpts: { refund: () => ({ status: 400, json: { error: { type: "invalid_request_error", code: "charge_already_refunded", message: "already" } } }) },
  });
  assert.equal((await ev.deliver(already.handler, paid())).status, 200);

  const down = setup({
    repo: fakeRepo({ outcome: "conflict", booking: details({ status: "payment_conflict", conflict_at: new Date() }) }),
    stripeOpts: { refund: () => ({ status: 500, json: { error: { type: "api_error", message: "boom" } } }) },
  });
  const r = await ev.deliver(down.handler, paid());
  assert.equal(r.status, 500);
  assert.equal(down.repo.calls.finish.length, 0, "event not marked processed");
  assert.equal(down.mailer.sent.length, 0, "no apology before the refund exists");
});

test("refund recorded before confirmation: refund e-mails, no confirmation", async () => {
  const { handler, mailer } = setup({ repo: fakeRepo({ outcome: "refunded", booking: details({ status: "refunded" }) }) });
  await ev.deliver(handler, paid());
  assert.deepEqual(mailer.kinds(), ["customer_refund", "studio_refund"]);
});

test("payment without a matching booking alerts the studio", async () => {
  for (const outcome of ["not_found", "session_mismatch"]) {
    const { handler, mailer } = setup({ repo: fakeRepo({ outcome }) });
    const r = await ev.deliver(handler, paid());
    assert.equal(r.status, 200);
    assert.deepEqual(mailer.kinds(), ["studio_alert"], outcome);
    assert.match(mailer.sent[0].subject, /ACTION NEEDED/);
  }
});

test("expired and failed sessions release the hold with the session id as proof", async () => {
  const { handler, repo } = setup();
  const s = ev.checkoutSession({ id: "cs_test_9", bookingId: BOOKING, paymentStatus: "unpaid" });
  assert.equal((await ev.deliver(handler, ev.makeEvent("checkout.session.expired", s))).json.result, "released_expired");
  assert.equal((await ev.deliver(handler, ev.makeEvent("checkout.session.async_payment_failed", s))).json.result, "released_cancelled");
  assert.deepEqual(repo.calls.release, [
    [BOOKING, "expired", { sessionId: "cs_test_9" }],
    [BOOKING, "cancelled", { sessionId: "cs_test_9" }],
  ]);
});

test("refunds: full refund e-mails, conflict refund silent, partial or unknown recorded only", async () => {
  const full = setup({ repo: fakeRepo({ refund: { booking_id: BOOKING, status: "refunded", conflict: false }, booking: details({ status: "refunded" }) }) });
  const r = await ev.deliver(full.handler, ev.makeEvent("charge.refunded", ev.charge({ paymentIntent: "pi_1" })));
  assert.equal(r.json.result, "booking_refunded");
  assert.deepEqual(full.repo.calls.refund[0], { paymentIntent: "pi_1", chargeId: full.repo.calls.refund[0].chargeId, amountCents: 20000, amountRefundedCents: 20000 });
  assert.deepEqual(full.mailer.kinds(), ["customer_refund", "studio_refund"]);

  const conflict = setup({ repo: fakeRepo({ refund: { booking_id: BOOKING, status: "refunded", conflict: true } }) });
  assert.equal((await ev.deliver(conflict.handler, ev.makeEvent("charge.refunded", ev.charge({ paymentIntent: "pi_1" })))).json.result, "conflict_refunded");
  assert.equal(conflict.mailer.sent.length, 0);

  const partial = setup({ repo: fakeRepo({ refund: { booking_id: BOOKING, status: "confirmed", conflict: false } }) });
  assert.equal((await ev.deliver(partial.handler, ev.makeEvent("charge.refunded", ev.charge({ paymentIntent: "pi_1", refunded: 5000 })))).json.result, "partial_refund");
  assert.equal(partial.mailer.sent.length, 0);

  const early = setup({ repo: fakeRepo({ refund: null }) });
  assert.equal((await ev.deliver(early.handler, ev.makeEvent("charge.refunded", ev.charge({ paymentIntent: "pi_1" })))).json.result, "refund_recorded");
});

test("Brevo temporary failure -> 500 (Stripe retries), permanent failure -> 200", async () => {
  const temp = setup();
  temp.mailer.failWith(new EmailError("Brevo API error 503", { retryable: true }));
  const r = await ev.deliver(temp.handler, paid());
  assert.equal(r.status, 500);
  assert.equal(temp.repo.calls.finish.length, 0);
  assert.equal(temp.repo.calls.confirm.length, 1, "booking confirmed even if the e-mail failed");

  const perm = setup();
  perm.mailer.failWith(new EmailError("Brevo API error 400", { retryable: false }), 1);
  const ok = await ev.deliver(perm.handler, paid());
  assert.equal(ok.status, 200);
  assert.deepEqual(perm.repo.calls.complete.map((c) => c[1]), ["abandoned", "sent"], "customer abandoned, studio sent");
});

test("database failure -> 500 without internals", async () => {
  const repo = fakeRepo();
  repo.confirmBooking = async () => { throw Object.assign(new Error("connection refused 10.0.0.5"), { code: "08006" }); };
  const { handler } = setup({ repo });
  const r = await ev.deliver(handler, paid());
  assert.equal(r.status, 500);
  assert.doesNotMatch(r.body, /10\.0\.0\.5|connection/);
});

test("customer without a valid e-mail: studio still notified", async () => {
  const { handler, mailer } = setup({ repo: fakeRepo({ booking: details({ customer_email: "not-an-email" }) }) });
  await ev.deliver(handler, paid({ email: "not-an-email" }));
  assert.deepEqual(mailer.kinds(), ["studio_confirmation"]);
});

test("legacy sessions (created before the booking system) keep the original e-mails, once", async () => {
  const repo = fakeRepo();
  const { handler, mailer } = setup({ repo });
  const legacy = ev.makeEvent("checkout.session.completed", ev.checkoutSession({
    id: "cs_legacy", metadata: { packageType: "starter", date: "3 December 2026", time: "10:00" },
  }));
  const r = await ev.deliver(handler, legacy);
  assert.equal(r.json.result, "legacy_confirmed");
  assert.equal(repo.calls.confirm.length, 0);
  assert.deepEqual(mailer.kinds(), ["legacy_customer", "legacy_studio"]);
  assert.equal(mailer.sent[0].subject, "MRKLL Studios — Booking Confirmed");
  assert.ok(mailer.sent[0].html.includes("Recording Starter"));
  await ev.deliver(handler, legacy);
  assert.equal(mailer.sent.length, 2, "no duplicate legacy e-mails");
});
