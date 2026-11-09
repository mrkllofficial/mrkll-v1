"use strict";

// In-memory stand-in for the Stripe SDK (checkout.sessions only).
// Tests never contact Stripe.
function createFakeStripe({ create, expire, retrieve, prefix = "cs_test_fake_" } = {}) {
  const calls = { create: [], expire: [], retrieve: [] };
  const sessions = new Map();
  let counter = 0;

  const api = {
    calls,
    sessions,
    checkout: {
      sessions: {
        async create(params, options) {
          calls.create.push({ params, options });
          if (create) return create(params, options);
          counter += 1;
          const id = `${prefix}${counter}`;
          const session = { id, url: `https://checkout.stripe.com/c/pay/${id}`, status: "open", params };
          sessions.set(id, session);
          return session;
        },
        async expire(id) {
          calls.expire.push(id);
          if (expire) return expire(id);
          const session = sessions.get(id) || { id, status: "open" };
          if (session.status !== "open") {
            const error = new Error("This Checkout Session is not in an expirable state.");
            error.type = "StripeInvalidRequestError";
            throw error;
          }
          session.status = "expired";
          sessions.set(id, session);
          return session;
        },
        async retrieve(id) {
          calls.retrieve.push(id);
          if (retrieve) return retrieve(id);
          return sessions.get(id) || { id, status: "open" };
        },
      },
    },
  };
  return api;
}

module.exports = { createFakeStripe };
