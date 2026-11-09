"use strict";

// POST /api/release-hold
// Body: { "bookingId": "<uuid>", "releaseToken": "<token from create-checkout-session>" }
//
// Releases a slot held by this browser (customer cancelled on Stripe, or
// chose another time). The Stripe Checkout Session is expired FIRST, so
// the customer can no longer pay for a slot that has been released.
//
// 200 { released: true | false }  — false when there is nothing to release
//     (unknown hold, wrong token, already paid/expired); no details are given.
// 400 INVALID_INPUT  403 ORIGIN_NOT_ALLOWED  405  415  500 CONFIG_ERROR
// 503 SERVICE_UNAVAILABLE (the hold will still expire by itself)

const { sendJson, sendError, allowMethods, log } = require("./_lib/http");
const { readJsonBody, BodyError } = require("./_lib/body");
const { getSiteConfig } = require("./_lib/config");
const security = require("./_lib/security");
const db = require("./_lib/db");
const stripeLib = require("./_lib/stripe");

// Expires the Stripe session. Returns "expired" when the customer can no
// longer pay, "complete" when the payment already went through.
async function closeCheckoutSession(stripe, sessionId) {
  try {
    const session = await stripe.checkout.sessions.expire(sessionId);
    return session.status === "complete" ? "complete" : "expired";
  } catch (error) {
    // Not expirable any more: find out why.
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.status === "expired") return "expired";
    if (session.status === "complete") return "complete";
    throw error;
  }
}

function createReleaseHoldHandler({
  getRepository = db.getRepository,
  getStripe = stripeLib.getStripe,
  getSite = getSiteConfig,
} = {}) {
  return async function releaseHold(req, res) {
    if (!allowMethods(req, res, ["POST"])) return;

    let site, repository, stripe;
    try {
      site = getSite();
      repository = getRepository();
      stripe = getStripe();
    } catch (error) {
      log("error", "release_config_error", { message: error && error.message });
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

    const { bookingId, releaseToken } = body;
    if (!security.isUuid(bookingId) || !security.isReleaseToken(releaseToken)) {
      return sendError(res, 400, "INVALID_INPUT", "Invalid request.");
    }
    const releaseTokenHash = security.hashToken(releaseToken);

    try {
      const hold = await repository.findHoldForRelease(bookingId, releaseTokenHash);
      if (!hold || hold.status !== "pending_payment") {
        return sendJson(res, 200, { released: false });
      }

      if (hold.stripe_checkout_session_id) {
        const outcome = await closeCheckoutSession(stripe, hold.stripe_checkout_session_id);
        if (outcome === "complete") {
          // Paid: the webhook confirms the booking; never release it here.
          return sendJson(res, 200, { released: false });
        }
      }

      const released = await repository.releaseHold(bookingId, "cancelled", { releaseTokenHash });
      if (released) log("info", "hold_released", { bookingId });
      return sendJson(res, 200, { released });
    } catch (error) {
      log("error", "release_failed", { bookingId, type: error && error.type, message: error && error.message });
      return sendError(res, 503, "SERVICE_UNAVAILABLE", "Could not release the booking right now. It will be released automatically.");
    }
  };
}

module.exports = createReleaseHoldHandler();
module.exports.createReleaseHoldHandler = createReleaseHoldHandler;
module.exports.closeCheckoutSession = closeCheckoutSession;
