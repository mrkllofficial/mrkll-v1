"use strict";

// POST /api/create-checkout-session
// Body: { "packageId": "pro", "date": "2026-12-03", "startTime": "10:00" }
//
// 1. validates the request (JSON only, same-origin browsers only);
// 2. holds the slot in the database (35 min) — the database guarantees
//    that no overlapping booking can exist;
// 3. creates a Stripe Checkout Session (30 min) with the price read from
//    the database, never from the browser;
// 4. links the session to the hold and returns the Checkout URL.
//
// 200 { url, bookingId, releaseToken, reference, holdExpiresAt }
//     releaseToken lets this browser release its own hold (POST /api/release-hold).
// 400 INVALID_INPUT | INVALID_JSON  403 ORIGIN_NOT_ALLOWED  404 PACKAGE_NOT_FOUND
// 405 METHOD_NOT_ALLOWED  409 SLOT_UNAVAILABLE | SLOT_NOT_BOOKABLE  413  415
// 429 TOO_MANY_HOLDS  500 CONFIG_ERROR  502 PAYMENT_PROVIDER_ERROR  503 SERVICE_UNAVAILABLE

const { sendJson, sendError, allowMethods, log } = require("./_lib/http");
const { readJsonBody, BodyError } = require("./_lib/body");
const { parsePackageId, parseIsoDate, parseTime } = require("./_lib/validate");
const { mapDbError } = require("./_lib/errors");
const { getSiteConfig, getIpSalt } = require("./_lib/config");
const security = require("./_lib/security");
const db = require("./_lib/db");
const stripeLib = require("./_lib/stripe");

const CHECKOUT_MINUTES = 30; // Stripe minimum; the hold lasts 35 minutes
const EXPIRY_MARGIN_SECONDS = 60; // Stripe needs >= 30 min at reception time
const HOLD_SAFETY_SECONDS = 120; // checkout must end at least 2 min before the hold

// Built from parts so the text is identical on every Node/ICU version.
function dateParts(instant, timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, weekday: "long", day: "numeric", month: "long", year: "numeric",
  }).formatToParts(instant);
  const get = (type) => parts.find((p) => p.type === type).value;
  return { weekday: get("weekday"), day: get("day"), month: get("month"), year: get("year") };
}

function formatStudioDate(instant, timeZone) {
  const p = dateParts(instant, timeZone);
  return `${p.weekday} ${p.day} ${p.month} ${p.year}`; // "Thursday 3 December 2026"
}

function formatShortDate(instant, timeZone) {
  const p = dateParts(instant, timeZone);
  return `${p.day} ${p.month} ${p.year}`; // "3 December 2026"
}

function formatStudioTime(instant, timeZone) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(instant);
}

// Builds the Stripe Checkout parameters from the database hold.
function buildCheckoutSessionParams({ hold, siteUrl, nowMs }) {
  const timeZone = hold.timezone || "Europe/Madrid";
  const startsAt = new Date(hold.starts_at);
  const endsAt = new Date(hold.ends_at);
  const holdExpiresSec = Math.floor(new Date(hold.hold_expires_at).getTime() / 1000);
  const expiresAt = Math.floor(nowMs / 1000) + CHECKOUT_MINUTES * 60 + EXPIRY_MARGIN_SECONDS;

  if (expiresAt > holdExpiresSec - HOLD_SAFETY_SECONDS) {
    throw new Error("Checkout would outlive the slot hold");
  }

  const dateLabel = formatStudioDate(startsAt, timeZone);
  const startLabel = formatStudioTime(startsAt, timeZone);
  const endLabel = formatStudioTime(endsAt, timeZone);
  const shortDate = formatShortDate(startsAt, timeZone);

  return {
    mode: "payment",
    // Card includes Apple Pay and Google Pay on Stripe Checkout; Link is
    // listed explicitly. All are instant, compatible with a 30-min hold.
    payment_method_types: ["card", "link"],
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: String(hold.currency).toLowerCase(),
          unit_amount: Number(hold.price_cents),
          product_data: {
            name: `MRKLL ${hold.package_name}`,
            description: `${dateLabel} · ${startLabel}–${endLabel} (Barcelona time) · Ref. ${hold.reference}`,
          },
        },
      },
    ],
    expires_at: expiresAt,
    client_reference_id: hold.booking_id,
    phone_number_collection: { enabled: true },
    billing_address_collection: "auto",
    locale: "auto",
    metadata: {
      booking_id: hold.booking_id,
      reference: hold.reference,
      package_id: hold.package_id,
      starts_at: new Date(hold.starts_at).toISOString(),
      // Read by the current e-mail webhook (kept for compatibility).
      packageType: hold.package_id,
      date: shortDate,
      time: startLabel,
    },
    payment_intent_data: {
      description: `MRKLL ${hold.package_name} — ${hold.reference}`,
      metadata: { booking_id: hold.booking_id, reference: hold.reference },
    },
    success_url: `${siteUrl}/booking-success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${siteUrl}/checkout.html?package=${encodeURIComponent(hold.package_id)}&cancelled=1`,
  };
}

function createCheckoutHandler({
  getRepository = db.getRepository,
  getStripe = stripeLib.getStripe,
  getSite = getSiteConfig,
  getSalt = getIpSalt,
  now = () => Date.now(),
} = {}) {
  return async function createCheckoutSession(req, res) {
    if (!allowMethods(req, res, ["POST"])) return;

    let site, salt, repository, stripe;
    try {
      site = getSite();
      salt = getSalt();
      repository = getRepository();
      stripe = getStripe();
    } catch (error) {
      log("error", "checkout_config_error", { message: error && error.message });
      return sendError(res, 500, "CONFIG_ERROR", "Booking is temporarily unavailable.");
    }

    if (!security.isAllowedOrigin(req, site.allowedOrigins)) {
      return sendError(res, 403, "ORIGIN_NOT_ALLOWED", "Request not allowed.");
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      if (error instanceof BodyError) return sendError(res, error.status, error.code, error.message);
      return sendError(res, 400, "INVALID_JSON", "Invalid JSON body.");
    }

    // "packageType" is the field name used by the current checkout page.
    const packageId = parsePackageId(body.packageId !== undefined ? body.packageId : body.packageType);
    const date = parseIsoDate(body.date);
    const startTime = parseTime(body.startTime);
    if (!packageId || !date || !startTime) {
      return sendError(res, 400, "INVALID_INPUT", "Please choose a package, a date and a time.");
    }

    const releaseToken = security.generateReleaseToken();
    const releaseTokenHash = security.hashToken(releaseToken);
    const ipHash = security.hashIp(security.getClientIp(req), salt);

    // 1. Hold the slot.
    let hold;
    try {
      hold = await repository.createHold({ packageId, date, startTime, ipHash, releaseTokenHash });
    } catch (error) {
      const known = mapDbError(error);
      if (known) return sendError(res, known.status, known.code, known.message);
      log("error", "checkout_hold_failed", { message: error && error.message, code: error && error.code, packageId, date, startTime });
      return sendError(res, 503, "SERVICE_UNAVAILABLE", "Booking is temporarily unavailable. Please try again.");
    }

    const releaseQuietly = async (why) => {
      try {
        await repository.releaseHold(hold.booking_id, "cancelled", { releaseTokenHash });
      } catch (error) {
        // The hold expires by itself after 35 minutes anyway.
        log("error", "checkout_release_failed", { why, bookingId: hold.booking_id, message: error && error.message });
      }
    };

    // 2. Create the Stripe Checkout Session.
    let session;
    try {
      const params = buildCheckoutSessionParams({ hold, siteUrl: site.siteUrl, nowMs: now() });
      session = await stripe.checkout.sessions.create(params, { idempotencyKey: `checkout-${hold.booking_id}` });
    } catch (error) {
      log("error", "checkout_stripe_failed", {
        bookingId: hold.booking_id, type: error && error.type, code: error && error.code, message: error && error.message,
      });
      await releaseQuietly("stripe_failed");
      return sendError(res, 502, "PAYMENT_PROVIDER_ERROR", "The payment service is not available right now. Please try again.");
    }

    // 3. Link the session to the hold.
    let attached = false;
    try {
      attached = await repository.attachCheckoutSession(hold.booking_id, session.id);
    } catch (error) {
      log("error", "checkout_attach_failed", { bookingId: hold.booking_id, message: error && error.message });
    }
    if (!attached) {
      try {
        await stripe.checkout.sessions.expire(session.id);
      } catch (error) {
        log("error", "checkout_expire_failed", { bookingId: hold.booking_id, message: error && error.message });
      }
      await releaseQuietly("attach_failed");
      return sendError(res, 503, "SERVICE_UNAVAILABLE", "Booking is temporarily unavailable. Please try again.");
    }

    log("info", "checkout_created", { bookingId: hold.booking_id, reference: hold.reference, packageId });
    return sendJson(res, 200, {
      url: session.url,
      bookingId: hold.booking_id,
      releaseToken,
      reference: hold.reference,
      holdExpiresAt: new Date(hold.hold_expires_at).toISOString(),
    });
  };
}

module.exports = createCheckoutHandler();
module.exports.createCheckoutHandler = createCheckoutHandler;
module.exports.buildCheckoutSessionParams = buildCheckoutSessionParams;
