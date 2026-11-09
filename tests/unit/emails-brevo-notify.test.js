"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { templates, money } = require("../../api/_lib/emails");
const { sendBrevoEmail, EmailError, BREVO_URL } = require("../../api/_lib/brevo");
const { deliverOnce, RetryableError } = require("../../api/_lib/notify");
const { getEmailConfig, getWebhookSecret, ConfigError } = require("../../api/_lib/config");

const booking = (overrides = {}) => ({
  id: "3f2b9c1e-8d4a-4b6f-9a1c-2e5d7f8a9b0c",
  reference: "MRK-1A2B3C4D",
  status: "confirmed",
  package_id: "pro",
  package_name: "Recording Pro",
  duration_minutes: 240,
  starts_at: "2026-12-03T09:00:00Z",
  ends_at: "2026-12-03T13:00:00Z",
  price_cents: 20000,
  amount_paid_cents: 20000,
  currency: "eur",
  customer_name: "Ana García",
  customer_email: "ana@example.com",
  customer_phone: "+34 600 000 000",
  stripe_checkout_session_id: "cs_test_1",
  stripe_payment_intent_id: "pi_1",
  conflict_at: null,
  timezone: "Europe/Madrid",
  ...overrides,
});

// ---------------- templates ----------------

test("customer confirmation: reference, Barcelona time, amount, html + text", () => {
  const m = templates.customer_confirmation(booking());
  assert.equal(m.subject, "MRKLL Studios — Booking confirmed (MRK-1A2B3C4D)");
  for (const part of ["MRKLL STUDIOS", "MRK-1A2B3C4D", "Recording Pro", "Thursday 3 December 2026", "10:00 – 14:00", "4 Hours", "€200.00", "MRKLL Studios · Barcelona", "Where Frequencies Become Reality."]) {
    assert.ok(m.html.includes(part), `html: ${part}`);
    assert.ok(m.text.includes(part), `text: ${part}`);
  }
  assert.ok(m.html.includes("Ana García"));
});

test("summer time and other packages", () => {
  const m = templates.customer_confirmation(booking({
    package_name: "Recording Legend", duration_minutes: 360, starts_at: "2027-06-23T13:00:00Z", ends_at: "2027-06-23T19:00:00Z", amount_paid_cents: 28000,
  }));
  assert.ok(m.text.includes("Wednesday 23 June 2027"));
  assert.ok(m.text.includes("15:00 – 21:00"));
  assert.ok(m.text.includes("6 Hours"));
  assert.ok(m.text.includes("€280.00"));
  assert.equal(money(12000, "eur"), "€120.00");
});

test("customer data is escaped and cannot inject headers", () => {
  const evil = booking({ customer_name: '<script>alert(1)</script>"', reference: "MRK-1\r\nBcc: x@evil.example" });
  for (const kind of ["customer_confirmation", "studio_confirmation", "customer_refund", "studio_refund", "customer_conflict", "studio_conflict", "studio_needs_review"]) {
    const m = templates[kind](evil);
    assert.ok(!m.html.includes("<script>"), kind);
    assert.ok(m.html.includes("&lt;script&gt;"), kind);
    assert.doesNotMatch(m.subject, /[\r\n]/, kind);
  }
});

test("studio e-mails contain the customer contact and Stripe references", () => {
  const m = templates.studio_confirmation(booking());
  assert.match(m.subject, /^New Booking — Recording Pro — Thu 3 Dec 10:00 \(MRK-1A2B3C4D\)$/);
  for (const part of ["ana@example.com", "+34 600 000 000", "cs_test_1", "pi_1"]) assert.ok(m.text.includes(part), part);
  assert.match(templates.studio_needs_review(booking({ amount_paid_cents: 9900 })).text, /€99\.00[\s\S]*Expected amount: €200\.00/);
});

test("legacy templates match the original webhook e-mails", () => {
  const c = templates.legacy_customer({ name: "Bo", packageName: "Recording Starter", duration: "2 Hours", date: "3 December 2026", time: "10:00", price: "€120" });
  assert.equal(c.subject, "MRKLL Studios — Booking Confirmed");
  assert.ok(c.html.includes("Booking confirmed") && c.html.includes("Recording Starter") && c.html.includes("€120"));
  const s = templates.legacy_studio({ name: "Bo", email: "bo@example.com", packageName: "Recording Starter", duration: "2 Hours", date: "x", time: "y", price: "€120", sessionId: "cs_1" });
  assert.equal(s.subject, "New Booking — Recording Starter");
});

// ---------------- configuration ----------------

test("e-mail configuration: key required, safe defaults, addresses validated", () => {
  assert.throws(() => getEmailConfig({}), ConfigError);
  const c = getEmailConfig({ BREVO_API_KEY: "xkeysib-test" });
  assert.deepEqual(c.sender, { email: "studios@mrkll.com", name: "MRKLL Studios" });
  assert.equal(c.studio.email, "studios@mrkll.com");
  assert.equal(getEmailConfig({ BREVO_API_KEY: "k", STUDIO_NOTIFICATION_EMAIL: "bookings@mrkll.com" }).studio.email, "bookings@mrkll.com");
  assert.throws(() => getEmailConfig({ BREVO_API_KEY: "k", BREVO_SENDER_EMAIL: "not an email" }), /BREVO_SENDER_EMAIL/);
  assert.throws(() => getWebhookSecret({ STRIPE_WEBHOOK_SECRET: "sk_test_x" }), /signing secret/);
  assert.equal(getWebhookSecret({ STRIPE_WEBHOOK_SECRET: "whsec_abc" }), "whsec_abc");
});

// ---------------- Brevo ----------------

function fakeFetch(status, body, capture = []) {
  return async (url, init) => {
    capture.push({ url, init, payload: JSON.parse(init.body) });
    return new Response(body === undefined ? "" : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
}

const message = {
  apiKey: "xkeysib-test",
  sender: { email: "studios@mrkll.com", name: "MRKLL Studios" },
  to: { email: "ana@example.com", name: "Ana" },
  replyTo: { email: "studios@mrkll.com", name: "MRKLL Studios" },
  subject: "S",
  html: "<p>h</p>",
  text: "t",
  tags: ["mrkll-booking"],
};

test("Brevo: request format and message id", async () => {
  const calls = [];
  const r = await sendBrevoEmail(message, { fetchImpl: fakeFetch(201, { messageId: "<msg@brevo>" }, calls) });
  assert.equal(r.messageId, "<msg@brevo>");
  assert.equal(calls[0].url, BREVO_URL);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["api-key"], "xkeysib-test");
  assert.deepEqual(calls[0].payload, {
    sender: message.sender, to: [message.to], subject: "S", htmlContent: "<p>h</p>", textContent: "t",
    tags: ["mrkll-booking"], replyTo: message.replyTo,
  });
});

test("Brevo: errors are classified as retryable or permanent, without leaking the key", async () => {
  for (const [status, retryable] of [[500, true], [503, true], [429, true], [401, true], [403, true], [400, false], [404, false]]) {
    await assert.rejects(
      sendBrevoEmail(message, { fetchImpl: fakeFetch(status, { code: "x", message: "m" }) }),
      (e) => e instanceof EmailError && e.retryable === retryable && e.status === status && !e.message.includes("xkeysib"),
      String(status)
    );
  }
  await assert.rejects(
    sendBrevoEmail(message, { fetchImpl: async () => { throw new TypeError("fetch failed"); } }),
    (e) => e instanceof EmailError && e.retryable
  );
  await assert.rejects(
    sendBrevoEmail(message, { fetchImpl: async (url, init) => {
      assert.ok(init.signal instanceof AbortSignal, "requests carry a timeout signal");
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    } }),
    (e) => e instanceof EmailError && e.retryable,
    "timeout"
  );
});

// ---------------- deliver once ----------------

function fakeRepo({ claim = true } = {}) {
  const calls = { claim: [], complete: [] };
  return {
    calls,
    async claimNotification(key, bookingId, kind) { calls.claim.push([key, bookingId, kind]); return claim; },
    async completeNotification(key, outcome, id, err) { calls.complete.push([key, outcome, id, err]); return true; },
  };
}

const msg = { subject: "s", html: "h", text: "t" };

test("deliverOnce: not claimed -> nothing sent", async () => {
  const repo = fakeRepo({ claim: false });
  let sent = 0;
  const r = await deliverOnce({ repository: repo, send: async () => { sent += 1; return {}; }, key: "k-1", kind: "x", message: msg, to: { email: "a@b.co" } });
  assert.equal(r, "skipped");
  assert.equal(sent, 0);
});

test("deliverOnce: sent and recorded", async () => {
  const repo = fakeRepo();
  const r = await deliverOnce({ repository: repo, send: async () => ({ messageId: "m1" }), key: "k-1", bookingId: "b", kind: "x", message: msg, to: { email: "a@b.co" } });
  assert.equal(r, "sent");
  assert.deepEqual(repo.calls.complete[0], ["k-1", "sent", "m1", null]);
});

test("deliverOnce: retryable failure recorded as failed and re-thrown", async () => {
  const repo = fakeRepo();
  await assert.rejects(
    deliverOnce({ repository: repo, send: async () => { throw new EmailError("Brevo API error 503", { retryable: true }); }, key: "k-1", kind: "x", message: msg, to: { email: "a@b.co" } }),
    RetryableError
  );
  assert.equal(repo.calls.complete[0][1], "failed");
});

test("deliverOnce: permanent failure recorded as abandoned, not re-thrown", async () => {
  const repo = fakeRepo();
  const r = await deliverOnce({ repository: repo, send: async () => { throw new EmailError("Brevo API error 400", { retryable: false }); }, key: "k-1", kind: "x", message: msg, to: { email: "a@b.co" } });
  assert.equal(r, "abandoned");
  assert.equal(repo.calls.complete[0][1], "abandoned");
});
