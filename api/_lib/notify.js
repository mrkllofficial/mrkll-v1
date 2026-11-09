"use strict";

// Sends one e-mail at most once, whatever the number of webhook deliveries:
//   claim (database) -> send (Brevo) -> record the outcome.
// A retryable failure is re-thrown so the webhook answers 500 and Stripe
// retries; a permanent failure is recorded as "abandoned" and logged.

const { EmailError } = require("./brevo");
const { log } = require("./http");

class RetryableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "RetryableError";
    this.cause = cause;
  }
}

async function deliverOnce({ repository, send, key, bookingId = null, kind, message, to, replyTo }) {
  const claimed = await repository.claimNotification(key, bookingId, kind);
  if (!claimed) return "skipped"; // already sent, or being sent right now

  try {
    const { messageId } = await send({ to, replyTo, subject: message.subject, html: message.html, text: message.text, tags: ["mrkll-booking", kind] });
    await repository.completeNotification(key, "sent", messageId, null);
    return "sent";
  } catch (error) {
    const retryable = !(error instanceof EmailError) || error.retryable;
    const outcome = retryable ? "failed" : "abandoned";
    try {
      await repository.completeNotification(key, outcome, null, error.message);
    } catch (recordError) {
      log("error", "email_outcome_not_recorded", { key, message: recordError.message });
    }
    log("error", "email_failed", { key, kind, bookingId, outcome, message: error.message });
    if (retryable) throw new RetryableError(`E-mail ${kind} not sent`, error);
    return "abandoned";
  }
}

module.exports = { deliverOnce, RetryableError };
