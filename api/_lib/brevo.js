"use strict";

// Brevo transactional e-mail API (POST /v3/smtp/email).
// Errors are classified: retryable ones (network, timeout, 429, 5xx, and
// 401/403 which usually mean a key to fix) make the Stripe webhook answer
// 500 so Stripe delivers the event again; other 4xx are permanent.

const BREVO_URL = "https://api.brevo.com/v3/smtp/email";

class EmailError extends Error {
  constructor(message, { retryable, status } = {}) {
    super(message);
    this.name = "EmailError";
    this.retryable = Boolean(retryable);
    this.status = status;
  }
}

async function sendBrevoEmail(
  { apiKey, sender, to, replyTo, subject, html, text, tags = [] },
  { fetchImpl = fetch, timeoutMs = 10000 } = {}
) {
  const payload = {
    sender,
    to: [{ email: to.email, ...(to.name ? { name: to.name } : {}) }],
    subject,
    htmlContent: html,
    textContent: text,
    tags,
  };
  if (replyTo) payload.replyTo = replyTo;

  let response;
  try {
    response = await fetchImpl(BREVO_URL, {
      method: "POST",
      headers: { "api-key": apiKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new EmailError(`Brevo request failed: ${error && error.name}`, { retryable: true });
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (response.status >= 200 && response.status < 300) {
    return { messageId: body && body.messageId ? String(body.messageId) : null };
  }

  const status = response.status;
  const retryable = status === 429 || status >= 500 || status === 401 || status === 403;
  const code = body && body.code ? String(body.code) : "unknown";
  throw new EmailError(`Brevo API error ${status} (${code})`, { retryable, status });
}

module.exports = { sendBrevoEmail, EmailError, BREVO_URL };
