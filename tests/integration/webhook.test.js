"use strict";

// Stripe webhook end to end on the real SQL schema: signed events, real
// database functions, fake Brevo and intercepted Stripe refunds.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { createWebhookHandler } = require("../../api/stripe-webhook");
const { createCheckoutHandler } = require("../../api/create-checkout-session");
const { createAvailabilityHandler } = require("../../api/availability");
const { EmailError } = require("../../api/_lib/brevo");
const { createPool, createPgRepository } = require("../helpers/pg-repository");
const { createFakeStripe } = require("../helpers/fake-stripe");
const { invoke, postJson, SITE } = require("../helpers/http");
const ev = require("../helpers/stripe-events");
const time = require("../../api/_lib/time");

const DB_URL = process.env.TEST_DATABASE_URL;

test("Stripe webhook against the real database", { skip: !DB_URL && "TEST_DATABASE_URL not set" }, async (t) => {
  const pool = createPool(DB_URL);
  const repo = createPgRepository(pool);
  const created = new Set();
  const site = () => ({ siteUrl: SITE, allowedOrigins: new Set([SITE]) });
  const availability = createAvailabilityHandler({ getRepository: () => repo });

  const makeWebhook = ({ mailer = ev.fakeMailer(), stripeOpts } = {}) => {
    const { stripe, refunds } = ev.stripeForWebhook(stripeOpts);
    const handler = createWebhookHandler({
      getRepository: () => repo, getStripe: () => stripe, getSecret: () => ev.WEBHOOK_SECRET,
      getEmail: () => ev.EMAIL_CONFIG, getLivemode: () => false, sendEmail: mailer.send,
    });
    return { handler, mailer, refunds };
  };

  // Creates a real hold + (fake) Stripe session through the checkout API.
  let ipCounter = 0;
  const hold = async (packageId, date, startTime) => {
    const stripe = createFakeStripe({ prefix: `cs_test_${crypto.randomBytes(4).toString("hex")}_` });
    const h = createCheckoutHandler({ getRepository: () => repo, getStripe: () => stripe, getSite: site, getSalt: () => "s".repeat(40) });
    ipCounter += 1;
    const r = await postJson(h, { packageId, date, startTime }, { ip: `100.64.0.${ipCounter}` });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    created.add(r.json.bookingId);
    const sessionId = [...stripe.sessions.keys()][0];
    return { bookingId: r.json.bookingId, sessionId, reference: r.json.reference, params: stripe.calls.create[0].params };
  };
  const completed = (hd, o = {}) => ev.makeEvent("checkout.session.completed", ev.checkoutSession({
    id: hd.sessionId, bookingId: hd.bookingId, paymentIntent: o.paymentIntent || `pi_${hd.bookingId.slice(0, 8)}`,
    amount: o.amount !== undefined ? o.amount : hd.params.line_items[0].price_data.unit_amount, ...o,
  }), o.eventId ? { id: o.eventId } : {});
  const booking = async (id) => (await pool.query("select * from bookings where id = $1", [id])).rows[0];
  const emails = async (id) => (await pool.query("select kind, status, attempts from email_notifications where booking_id = $1 order by kind", [id])).rows;
  const slotFree = async (pkg, date, start) => {
    const r = await invoke(availability, { query: { package: pkg, month: date.slice(0, 7) } });
    return r.json.days.find((d) => d.date === date).slots.find((s) => s.start === start).available;
  };

  // Free open days for isolated scenarios.
  const today = time.todayIn("Europe/Madrid");
  const days = [];
  for (let m = today.slice(0, 7); m <= time.addDays(today, 90).slice(0, 7); m = time.addMonths(m, 1)) {
    const r = await invoke(availability, { query: { package: "starter", month: m } });
    for (const d of r.json.days) if (d.date > time.addDays(today, 2) && d.status === "available" && d.slots.every((s) => s.available)) days.push(d.date);
  }
  assert.ok(days.length >= 10, "free days available");

  t.after(async () => {
    if (created.size) {
      await pool.query("delete from email_notifications where booking_id = any($1::uuid[])", [[...created]]);
      await pool.query("delete from stripe_events where booking_id = any($1::uuid[])", [[...created]]);
      await pool.query("delete from bookings where id = any($1::uuid[])", [[...created]]);
    }
    await pool.query("delete from payment_refunds where payment_intent_id like 'pi_it_%' or charge_id like 'ch_%'");
    await pool.end();
  });

  await t.test("payment confirms the booking and sends two e-mails, exactly once", async () => {
    const hd = await hold("pro", days[0], "10:00");
    const { handler, mailer } = makeWebhook();
    const event = completed(hd);
    const r = await ev.deliver(handler, event);
    assert.equal(r.status, 200);
    assert.equal(r.json.result, "confirmed");

    const b = await booking(hd.bookingId);
    assert.equal(b.status, "confirmed");
    assert.equal(b.amount_paid_cents, 20000);
    assert.equal(b.customer_email, "ana@example.com");
    assert.equal(b.hold_expires_at, null);
    assert.ok(b.customer_email_sent_at && b.studio_email_sent_at, "booking e-mail columns updated");
    assert.deepEqual(mailer.kinds(), ["customer_confirmation", "studio_confirmation"]);
    assert.ok(mailer.sent[0].subject.includes(hd.reference));
    assert.deepEqual(await emails(hd.bookingId), [
      { kind: "customer_confirmation", status: "sent", attempts: 1 },
      { kind: "studio_confirmation", status: "sent", attempts: 1 },
    ]);

    // same event again (Stripe retry) -> skipped
    const again = await ev.deliver(handler, event);
    assert.equal(again.json.duplicate, true);
    // a different event for the same payment -> no new e-mail
    const other = await ev.deliver(handler, ev.makeEvent("checkout.session.async_payment_succeeded", event.data.object));
    assert.equal(other.json.result, "already_confirmed");
    assert.equal(mailer.sent.length, 2);
    assert.equal(await slotFree("pro", days[0], "10:00"), false);
  });

  await t.test("concurrent deliveries of the same payment: one confirmation, two e-mails", async () => {
    const hd = await hold("legend", days[1], "12:30");
    const { handler, mailer } = makeWebhook();
    const events = [completed(hd), completed(hd), completed(hd, { eventId: undefined })];
    const sameId = completed(hd);
    const deliveries = [...events, sameId, sameId, ev.makeEvent("checkout.session.async_payment_succeeded", sameId.data.object)];
    const results = await Promise.all(deliveries.map((e) => ev.deliver(handler, e)));
    assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.status)));
    assert.equal((await booking(hd.bookingId)).status, "confirmed");
    assert.deepEqual(mailer.kinds().sort(), ["customer_confirmation", "studio_confirmation"]);
  });

  await t.test("expired session releases the slot; a late expiry never cancels a paid booking", async () => {
    const hd = await hold("starter", days[2], "15:00");
    const { handler } = makeWebhook();
    const expired = ev.makeEvent("checkout.session.expired", ev.checkoutSession({ id: hd.sessionId, bookingId: hd.bookingId, paymentStatus: "unpaid" }));
    assert.equal((await ev.deliver(handler, expired)).json.result, "released_expired");
    assert.equal((await booking(hd.bookingId)).status, "expired");
    assert.equal(await slotFree("starter", days[2], "15:00"), true);

    const paidHold = await hold("starter", days[2], "17:30");
    await ev.deliver(handler, completed(paidHold));
    const lateExpiry = ev.makeEvent("checkout.session.expired", ev.checkoutSession({ id: paidHold.sessionId, bookingId: paidHold.bookingId, paymentStatus: "unpaid" }));
    assert.equal((await ev.deliver(handler, lateExpiry)).json.result, "nothing_to_release");
    assert.equal((await booking(paidHold.bookingId)).status, "confirmed");
  });

  await t.test("failed asynchronous payment releases the slot", async () => {
    const hd = await hold("pro", days[3], "15:00");
    const { handler } = makeWebhook();
    const failed = ev.makeEvent("checkout.session.async_payment_failed", ev.checkoutSession({ id: hd.sessionId, bookingId: hd.bookingId, paymentStatus: "unpaid" }));
    assert.equal((await ev.deliver(handler, failed)).json.result, "released_cancelled");
    assert.equal((await booking(hd.bookingId)).status, "cancelled");
    assert.equal(await slotFree("pro", days[3], "15:00"), true);
  });

  await t.test("full refund cancels the booking, frees the slot, e-mails once", async () => {
    const hd = await hold("pro", days[4], "12:30");
    const { handler, mailer } = makeWebhook();
    const pi = `pi_it_${crypto.randomBytes(4).toString("hex")}`;
    await ev.deliver(handler, completed(hd, { paymentIntent: pi }));
    const refund = ev.makeEvent("charge.refunded", ev.charge({ paymentIntent: pi, amount: 20000 }));
    assert.equal((await ev.deliver(handler, refund)).json.result, "booking_refunded");
    assert.equal((await booking(hd.bookingId)).status, "refunded");
    assert.equal(await slotFree("pro", days[4], "12:30"), true);
    await ev.deliver(handler, ev.makeEvent("charge.refunded", refund.data.object)); // duplicate with new id
    assert.deepEqual(mailer.kinds(), ["customer_confirmation", "studio_confirmation", "customer_refund", "studio_refund"]);
  });

  await t.test("partial refund keeps the booking", async () => {
    const hd = await hold("starter", days[5], "10:00");
    const { handler, mailer } = makeWebhook();
    const pi = `pi_it_${crypto.randomBytes(4).toString("hex")}`;
    await ev.deliver(handler, completed(hd, { paymentIntent: pi }));
    const r = await ev.deliver(handler, ev.makeEvent("charge.refunded", ev.charge({ paymentIntent: pi, amount: 12000, refunded: 3000 })));
    assert.equal(r.json.result, "partial_refund");
    assert.equal((await booking(hd.bookingId)).status, "confirmed");
    assert.equal(mailer.sent.length, 2);
  });

  await t.test("out of order: refund event before the payment event", async () => {
    const hd = await hold("legend", days[6], "10:00");
    const { handler, mailer } = makeWebhook();
    const pi = `pi_it_${crypto.randomBytes(4).toString("hex")}`;
    const r1 = await ev.deliver(handler, ev.makeEvent("charge.refunded", ev.charge({ paymentIntent: pi, amount: 28000 })));
    assert.equal(r1.json.result, "refund_recorded");
    const r2 = await ev.deliver(handler, completed(hd, { paymentIntent: pi }));
    assert.equal(r2.json.result, "refunded");
    assert.equal((await booking(hd.bookingId)).status, "refunded");
    assert.equal(await slotFree("legend", days[6], "10:00"), true);
    assert.deepEqual(mailer.kinds(), ["customer_refund", "studio_refund"], "no confirmation for a refunded payment");
  });

  await t.test("conflict: late payment on a taken slot is refunded automatically, once", async () => {
    const late = await hold("pro", days[7], "10:00");
    await pool.query("update bookings set hold_expires_at = now() - interval '1 second' where id = $1", [late.bookingId]);
    const winner = await hold("starter", days[7], "12:30"); // overlaps pro 10:00-14:00
    const { handler, mailer, refunds } = makeWebhook();
    const pi = `pi_it_${crypto.randomBytes(4).toString("hex")}`;
    const event = completed(late, { paymentIntent: pi });
    assert.equal((await ev.deliver(handler, event)).json.result, "conflict");
    const b = await booking(late.bookingId);
    assert.equal(b.status, "payment_conflict");
    assert.ok(b.conflict_at);
    assert.equal(refunds.length, 1);
    assert.equal(refunds[0].idempotencyKey, `conflict-refund-${late.bookingId}`);
    assert.deepEqual(mailer.kinds(), ["customer_conflict", "studio_conflict"]);
    assert.equal((await booking(winner.bookingId)).status, "pending_payment", "the other customer keeps the slot");

    // Stripe confirms the refund: booking closed, no extra e-mails
    const refunded = await ev.deliver(handler, ev.makeEvent("charge.refunded", ev.charge({ paymentIntent: pi, amount: 20000 })));
    assert.equal(refunded.json.result, "conflict_refunded");
    assert.equal((await booking(late.bookingId)).status, "refunded");
    // replay of the payment event with a new id: no second refund call result change, no e-mails
    await ev.deliver(handler, completed(late, { paymentIntent: pi }));
    assert.equal(mailer.sent.length, 2);
  });

  await t.test("Brevo down: booking confirmed, 500, then the retry sends only the missing e-mails", async () => {
    const hd = await hold("starter", days[8], "20:00");
    const mailer = ev.fakeMailer();
    const { handler } = makeWebhook({ mailer });
    const event = completed(hd);
    mailer.failWith(new EmailError("Brevo API error 503", { retryable: true }), 1);
    const first = await ev.deliver(handler, event);
    assert.equal(first.status, 500);
    assert.equal((await booking(hd.bookingId)).status, "confirmed");
    assert.deepEqual(await emails(hd.bookingId), [{ kind: "customer_confirmation", status: "failed", attempts: 1 }]);

    const retry = await ev.deliver(handler, event); // Stripe redelivers the same event
    assert.equal(retry.status, 200);
    assert.deepEqual(mailer.kinds(), ["customer_confirmation", "studio_confirmation"]);
    assert.deepEqual(await emails(hd.bookingId), [
      { kind: "customer_confirmation", status: "sent", attempts: 2 },
      { kind: "studio_confirmation", status: "sent", attempts: 1 },
    ]);
    assert.equal((await ev.deliver(handler, event)).json.duplicate, true);
  });

  await t.test("amount mismatch: slot kept, studio alerted", async () => {
    const hd = await hold("pro", days[9], "17:30");
    const { handler, mailer } = makeWebhook();
    assert.equal((await ev.deliver(handler, completed(hd, { amount: 100 }))).json.result, "needs_review");
    assert.equal((await booking(hd.bookingId)).status, "needs_review");
    assert.equal(await slotFree("pro", days[9], "17:30"), false);
    assert.deepEqual(mailer.kinds(), ["studio_needs_review"]);
  });

  await t.test("events with a forged booking id cannot confirm anything", async () => {
    const hd = await hold("starter", days[9], "10:00");
    const { handler, mailer } = makeWebhook();
    const forged = ev.makeEvent("checkout.session.completed", ev.checkoutSession({ id: "cs_test_forged", bookingId: hd.bookingId, paymentIntent: "pi_it_forged" }));
    assert.equal((await ev.deliver(handler, forged)).json.result, "session_mismatch");
    assert.equal((await booking(hd.bookingId)).status, "pending_payment");
    assert.deepEqual(mailer.kinds(), ["studio_alert"]);
  });
});
