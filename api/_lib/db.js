"use strict";

// Data access for the booking system. All queries go through the Supabase
// Data API with the SECRET key (server-side only). Tables have RLS enabled
// with no policies, so nothing is reachable with a public key.

const { createClient } = require("@supabase/supabase-js");
const { getSupabaseConfig } = require("./config");
const { DbError } = require("./errors");

function toDbError(error) {
  return new DbError(error && error.message ? error.message : "Database error", error && error.code);
}

// Repository over a Supabase client. The same interface is implemented in
// tests with a direct PostgreSQL connection (tests/helpers/pg-repository.js).
function createSupabaseRepository(client) {
  return {
    async getSettings() {
      const { data, error } = await client
        .from("studio_settings")
        .select("timezone, max_advance_days, min_notice_hours, buffer_minutes")
        .single();
      if (error) throw toDbError(error);
      return data;
    },

    async getPackage(packageId) {
      const { data, error } = await client
        .from("packages")
        .select("id, name, duration_minutes, price_cents, currency")
        .eq("id", packageId)
        .eq("active", true)
        .maybeSingle();
      if (error) throw toDbError(error);
      return data || null;
    },

    async getAvailability(packageId, fromDate, toDate) {
      const { data, error } = await client.rpc("get_availability", {
        p_package_id: packageId,
        p_from: fromDate,
        p_to: toDate,
      });
      if (error) throw toDbError(error);
      return data || [];
    },
  };
}

let cachedRepository = null;

// Lazily created and reused across invocations of a warm function.
function getRepository() {
  if (!cachedRepository) {
    const { url, secretKey } = getSupabaseConfig();
    const client = createClient(url, secretKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { "X-Client-Info": "mrkll-api" } },
    });
    cachedRepository = createSupabaseRepository(client);
  }
  return cachedRepository;
}

module.exports = { createSupabaseRepository, getRepository, toDbError };
