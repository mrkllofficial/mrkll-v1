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

module.exports = { ConfigError, requireEnv, getSupabaseConfig };
