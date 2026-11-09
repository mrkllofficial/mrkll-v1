"use strict";

// Server-side configuration. Values come only from environment variables
// (Vercel → Settings → Environment Variables) and are never sent to the browser.

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

function requireEnv(name, env = process.env) {
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`Missing environment variable ${name}`);
  }
  return value.trim();
}

function getSupabaseConfig(env = process.env) {
  const url = requireEnv("SUPABASE_URL", env);
  const secretKey = requireEnv("SUPABASE_SECRET_KEY", env);

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError("SUPABASE_URL is not a valid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new ConfigError("SUPABASE_URL must use https");
  }
  // The publishable/anon key cannot read anything (RLS); refusing it early
  // gives a clear error instead of confusing permission failures.
  if (secretKey.startsWith("sb_publishable_")) {
    throw new ConfigError("SUPABASE_SECRET_KEY contains a publishable key; use the secret key");
  }

  return { url: parsed.origin, secretKey };
}

// Public base URL of the site (used for Stripe success/cancel URLs) and the
// origins allowed to call the booking API from a browser.
function getSiteConfig(env = process.env) {
  const raw = requireEnv("SITE_URL", env);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError("SITE_URL is not a valid URL");
  }
  const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(isLocal && parsed.protocol === "http:")) {
    throw new ConfigError("SITE_URL must use https");
  }
  const allowedOrigins = new Set([parsed.origin]);
  // Vercel system variables: the current deployment and branch URLs (Preview).
  for (const name of ["VERCEL_URL", "VERCEL_BRANCH_URL"]) {
    if (env[name]) allowedOrigins.add(`https://${env[name]}`);
  }
  return { siteUrl: parsed.origin, allowedOrigins };
}

// Stripe secret key. Live keys are refused unless live payments are
// explicitly enabled (STRIPE_LIVE_MODE=enabled), so a misconfigured
// Preview/staging deployment can never take real payments.
function getStripeConfig(env = process.env) {
  const secretKey = requireEnv("STRIPE_SECRET_KEY", env);
  const isTest = /^(sk|rk)_test_/.test(secretKey);
  const isLive = /^(sk|rk)_live_/.test(secretKey);
  if (!isTest && !isLive) {
    throw new ConfigError("STRIPE_SECRET_KEY is not a Stripe secret or restricted key");
  }
  if (isLive && env.STRIPE_LIVE_MODE !== "enabled") {
    throw new ConfigError("Live Stripe key refused: live payments are not enabled");
  }
  return { secretKey, livemode: isLive };
}

// Secret used to pseudonymise client IPs (anti-abuse limit on holds).
function getIpSalt(env = process.env) {
  const salt = requireEnv("BOOKING_IP_SALT", env);
  if (salt.length < 32) {
    throw new ConfigError("BOOKING_IP_SALT must be at least 32 characters");
  }
  return salt;
}

module.exports = { ConfigError, requireEnv, getSupabaseConfig, getSiteConfig, getStripeConfig, getIpSalt };
