"use strict";

const Stripe = require("stripe");
const { getStripeConfig } = require("./config");

// API version pinned to the one bundled with the installed SDK (stripe@13),
// so a change of the account default cannot alter behaviour silently.
const STRIPE_API_VERSION = "2023-08-16";

function createStripeClient(secretKey, extraOptions = {}) {
  return Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION,
    maxNetworkRetries: 2,
    timeout: 15000,
    appInfo: { name: "mrkll-booking" },
    ...extraOptions,
  });
}

let cachedClient = null;

function getStripe() {
  if (!cachedClient) {
    const { secretKey } = getStripeConfig();
    cachedClient = createStripeClient(secretKey);
  }
  return cachedClient;
}

module.exports = { getStripe, createStripeClient, STRIPE_API_VERSION };
