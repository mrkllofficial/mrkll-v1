"use strict";

// POST /api/stripe-webhook — Stripe events for the booking system.
//
// Verified with the endpoint signing secret on the RAW body. Handled events:
//   checkout.session.completed (paid)          -> confirm booking + e-mails
//   checkout.session.async_payment_succeeded   -> same as above
//   checkout.session.async_payment_failed      -> release the hold
//   checkout.session.expired                   -> release the hold
//   charge.refunded                            -> record refund; full refund cancels the booking
// Any other event type is acknowledged and ignored.
//
// Idempotency: every database step is idempotent, e-mails are claimed in
// the database before sending (sent at most once), and a fully processed
// event id is skipped. Order of delivery does not matter (e.g. a refund
// recorded before the payment confirmation is applied when it arrives).
//
// Responses: 200 processed/ignored · 400 bad signature · 500 temporary
// failure (Stripe retries the delivery for up to 3 days).

const { sendJson, sendError, log } = require("./_lib/http");
const { getWebhookSecret, getEmailConfig, getStripeConfig, EMAIL_RE } = require("./_lib/config");
const { isUuid } = require("./_lib/security");
const { templates } = require("./_lib/emails");
const { deliverOnce, RetryableError } = require("./_lib/notify");
const { sendBrevoEmail } = require("./_lib/brevo");
const db = require("./_lib/db");
const stripeLib = require("./_lib/stripe");

const HANDLED = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "charge.refunded",
]);

// Packages of sessions created before the booking system (no booking_id).
const LEGACY_PACKAGES = {
  starter: { name: "Recording Starter", duration: "2 Hours", price: "€120" },
  pro: { name: "Recording Pro", duration: "4 Hours", price: "€200" },
  legend: { name: "Recording Legend", duration: "6 Hours", price: "€280" },
};

function readRawBody(req) {
  if (Buffer.isBuffer(req.rawBody)) return Promise.resolve(req.rawBody);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 512 * 1024) {
        reject(new Error("Webhook body too large"));
        return;
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const idOf = (value) => (value && typeof value === "object" ? value.id : value) || null;

function bookingIdOf(session) {
  const candidate = (session.metadata && session.metadata.booking_id) || session.client_reference_id;
  return isUuid(candidate) ? candidate : null;
}

function validEmail(value) {
  return typeof value === "string" && EMAIL_RE.test(value) ? value : null;
}

function createWebhookHandler({
  getRepository = db.getRepository,
  getStripe = stripeLib.getStripe,
  getSecret = getWebhookSecret,
  getEmail = getEmailConfig,
  getLivemode = () => getStripeConfig().livemode,
  sendEmail = sendBrevoEmail,
  readBody = readRawBody,
} = {}) {
  return async function stripeWebhook(req, res) {
    if (req.method !== "POST") {
      return sendError(res, 405, "METHOD_NOT_ALLOWED", "Method not allowed", {}, { Allow: "POST" });
    }

    let secret, repository, stripe, email, livemode;
    try {
      secret = getSecret();
      repository = getRepository();
      stripe = getStripe();
      email = getEmail();
      livemode = getLivemode();
    } catch (error) {
      // 500: Stripe keeps retrying until the configuration is fixed.
      log("error", "webhook_config_error", { message: error && error.message });
      return sendError(res, 500, "CONFIG_ERROR", "Webhook not configured.");
    }

    const signature = req.headers && req.headers["stripe-signature"];
    if (!signature) {
      return sendError(res, 400, "MISSING_SIGNATURE", "Missing Stripe signature.");
    }

    let event;
    try {
      const rawBody = await readBody(req);
      event = stripe.webhooks.constructEvent(rawBody, signature, secret);
    } catch (error) {
      log("error", "webhook_signature_invalid", { message: error && error.message });
      return sendError(res, 400, "INVALID_SIGNATURE", "Invalid webhook signature.");
    }

    if (Boolean(event.livemode) !== Boolean(livemode)) {
      log("error", "webhook_mode_mismatch", { eventId: event.id, eventLivemode: event.livemode });
      return sendJson(res, 200, { received: true, ignored: true });
    }

    if (!HANDLED.has(event.type)) {
      return sendJson(res, 200, { received: true, ignored: true });
    }

    const object = (event.data && event.data.object) || {};
    const bookingId = event.type.startsWith("checkout.session.") ? bookingIdOf(object) : null;

    const send = ({ to, replyTo, subject, html, text, tags }) =>
      sendEmail({ apiKey: email.apiKey, sender: email.sender, to, replyTo, subject, html, text, tags });

    const ctx = { repository, stripe, email, send, event };

    try {
      const state = await repository.beginStripeEvent(event.id, event.type, bookingId);
      if (state === "processed") {
        return sendJson(res, 200, { received: true, duplicate: true });
      }

      let result;
      switch (event.type) {
        case "checkout.session.completed":
        case "checkout.session.async_payment_succeeded":
          result = await handlePaid(ctx, object, bookingId);
          break;
        case "checkout.session.async_payment_failed":
          result = await handleReleased(ctx, object, bookingId, "cancelled");
          break;
        case "checkout.session.expired":
          result = await handleReleased(ctx, object, bookingId, "expired");
          break;
        case "charge.refunded":
          result = await handleRefund(ctx, object);
          break;
        default:
          result = "ignored";
      }

      await repository.finishStripeEvent(event.id);
      log("info", "webhook_processed", { eventId: event.id, type: event.type, bookingId, result });
      return sendJson(res, 200, { received: true, result });
    } catch (error) {
      log("error", "webhook_failed", {
        eventId: event.id,
        type: event.type,
        bookingId,
        retryable: error instanceof RetryableError,
        message: error && error.message,
        cause: error && error.cause && error.cause.message,
      });
      return sendError(res, 500, "PROCESSING_FAILED", "Temporary failure, please retry.");
    }
  };
}

// ---------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------

async function handlePaid(ctx, session, bookingId) {
  if (session.mode && session.mode !== "payment") return "ignored";
  if (session.payment_status !== "paid") return "awaiting_payment"; // async method still pending

  if (!bookingId) return handleLegacy(ctx, session);

  const details = session.customer_details || {};
  const outcome = await ctx.repository.confirmBooking({
    bookingId,
    sessionId: session.id,
    paymentIntent: idOf(session.payment_intent),
    amountCents: session.amount_total,
    currency: session.currency,
    name: details.name || null,
    email: details.email || null,
    phone: details.phone || null,
  });

  switch (outcome) {
    case "confirmed":
    case "already_confirmed": {
      const b = await ctx.repository.getBookingDetails(bookingId);
      await sendToCustomer(ctx, b, "customer_confirmation");
      await sendToStudio(ctx, b, "studio_confirmation");
      return outcome;
    }
    case "needs_review": {
      const b = await ctx.repository.getBookingDetails(bookingId);
      await sendToStudio(ctx, b, "studio_needs_review");
      return outcome;
    }
    case "conflict": {
      const b = await ctx.repository.getBookingDetails(bookingId);
      await refundConflict(ctx, b);
      await sendToCustomer(ctx, b, "customer_conflict");
      await sendToStudio(ctx, b, "studio_conflict");
      return outcome;
    }
    case "refunded": {
      // A refund was recorded before this confirmation (out-of-order events).
      const b = await ctx.repository.getBookingDetails(bookingId);
      if (!b.conflict_at) {
        await sendToCustomer(ctx, b, "customer_refund");
        await sendToStudio(ctx, b, "studio_refund");
      }
      return outcome;
    }
    case "not_found":
    case "session_mismatch":
      await alertStudio(ctx, `payment without a matching booking (${outcome})`, session);
      return outcome;
    default:
      return outcome || "ignored";
  }
}

async function handleReleased(ctx, session, bookingId, reason) {
  if (!bookingId) return "ignored";
  const released = await ctx.repository.releaseHold(bookingId, reason, { sessionId: session.id });
  return released ? `released_${reason}` : "nothing_to_release";
}

async function handleRefund(ctx, charge) {
  const paymentIntent = idOf(charge.payment_intent);
  if (!paymentIntent) return "ignored";
  const r = await ctx.repository.recordRefund({
    paymentIntent,
    chargeId: charge.id || null,
    amountCents: Number(charge.amount),
    amountRefundedCents: Number(charge.amount_refunded),
  });
  if (!r || !r.booking_id) return "refund_recorded"; // applied when the payment is confirmed
  if (r.status === "refunded" && !r.conflict) {
    const b = await ctx.repository.getBookingDetails(r.booking_id);
    await sendToCustomer(ctx, b, "customer_refund");
    await sendToStudio(ctx, b, "studio_refund");
    return "booking_refunded";
  }
  return r.status === "refunded" ? "conflict_refunded" : "partial_refund";
}

// Refund for a payment whose slot was taken. Idempotent on Stripe's side.
async function refundConflict(ctx, b) {
  if (!b.stripe_payment_intent_id) {
    throw new RetryableError("Conflict without payment intent");
  }
  try {
    await ctx.stripe.refunds.create(
      { payment_intent: b.stripe_payment_intent_id, reason: "requested_by_customer", metadata: { booking_id: b.id, reason: "slot_conflict" } },
      { idempotencyKey: `conflict-refund-${b.id}` }
    );
  } catch (error) {
    if (error && error.code === "charge_already_refunded") return;
    throw new RetryableError("Automatic refund failed", error);
  }
}

// ---------------------------------------------------------------------
// E-mails
// ---------------------------------------------------------------------

async function sendToCustomer(ctx, b, kind) {
  const to = validEmail(b.customer_email);
  if (!to) {
    log("error", "email_customer_missing", { bookingId: b.id, kind });
    return "no_address";
  }
  return deliverOnce({
    repository: ctx.repository,
    send: ctx.send,
    key: `${b.id}:${kind}`,
    bookingId: b.id,
    kind,
    message: templates[kind](b),
    to: { email: to, name: b.customer_name || "" },
    replyTo: ctx.email.studio,
  });
}

async function sendToStudio(ctx, b, kind) {
  const customer = validEmail(b.customer_email);
  return deliverOnce({
    repository: ctx.repository,
    send: ctx.send,
    key: `${b.id}:${kind}`,
    bookingId: b.id,
    kind,
    message: templates[kind](b),
    to: ctx.email.studio,
    replyTo: customer ? { email: customer, name: b.customer_name || "" } : undefined,
  });
}

async function alertStudio(ctx, title, session) {
  const details = session.customer_details || {};
  return deliverOnce({
    repository: ctx.repository,
    send: ctx.send,
    key: `alert:${ctx.event.id}`,
    kind: "studio_alert",
    message: templates.studio_alert({
      title,
      details: [
        ["Stripe event", ctx.event.id],
        ["Stripe session", session.id],
        ["Payment intent", idOf(session.payment_intent) || "—"],
        ["Amount", session.amount_total !== undefined ? `${(session.amount_total / 100).toFixed(2)} ${String(session.currency || "").toUpperCase()}` : "—"],
        ["Customer", details.name || "—"],
        ["Email", details.email || "—"],
        ["Metadata", JSON.stringify(session.metadata || {})],
      ],
    }),
    to: ctx.email.studio,
  });
}

// Sessions created by the previous checkout (no booking in the database):
// same e-mails as the original webhook, now sent at most once.
async function handleLegacy(ctx, session) {
  const meta = session.metadata || {};
  const pkg = LEGACY_PACKAGES[meta.packageType] || LEGACY_PACKAGES.pro;
  const details = session.customer_details || {};
  const data = {
    name: details.name || "MRKLL Client",
    email: details.email || null,
    packageName: pkg.name,
    duration: pkg.duration,
    date: meta.date || "",
    time: meta.time || "",
    price: pkg.price,
    sessionId: session.id,
  };
  const to = validEmail(details.email);
  if (to) {
    await deliverOnce({
      repository: ctx.repository, send: ctx.send, key: `legacy:${session.id}:customer`, kind: "legacy_customer",
      message: templates.legacy_customer(data), to: { email: to, name: data.name }, replyTo: ctx.email.studio,
    });
  }
  await deliverOnce({
    repository: ctx.repository, send: ctx.send, key: `legacy:${session.id}:studio`, kind: "legacy_studio",
    message: templates.legacy_studio(data), to: ctx.email.studio,
  });
  return "legacy_confirmed";
}

module.exports = createWebhookHandler();
module.exports.createWebhookHandler = createWebhookHandler;
// Raw body is required for the signature: disable automatic parsing.
// (Assigned AFTER module.exports, so it is not overwritten.)
module.exports.config = { api: { bodyParser: false } };
