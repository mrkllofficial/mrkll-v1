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

    // Temporarily holds a slot. Returns the new booking row (see SQL
    // create_booking_hold) or throws a DbError with a business code.
    async createHold({ packageId, date, startTime, ipHash, releaseTokenHash }) {
      const { data, error } = await client.rpc("create_booking_hold", {
        p_package_id: packageId,
        p_date: date,
        p_start_time: startTime,
        p_ip_hash: ipHash,
        p_release_token_hash: releaseTokenHash,
      });
      if (error) throw toDbError(error);
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) throw new DbError("create_booking_hold returned no row");
      return row;
    },

    async attachCheckoutSession(bookingId, sessionId) {
      const { data, error } = await client.rpc("attach_checkout_session", {
        p_booking_id: bookingId,
        p_session_id: sessionId,
      });
      if (error) throw toDbError(error);
      return data === true;
    },

    // reason: "cancelled" | "expired". Proof: Stripe session id and/or token hash.
    async releaseHold(bookingId, reason, { sessionId = null, releaseTokenHash = null } = {}) {
      const { data, error } = await client.rpc("release_hold", {
        p_booking_id: bookingId,
        p_reason: reason,
        p_session_id: sessionId,
        p_release_token_hash: releaseTokenHash,
      });
      if (error) throw toDbError(error);
      return data === true;
    },

    // Only returns the hold when the release token matches.
    async findHoldForRelease(bookingId, releaseTokenHash) {
      const { data, error } = await client
        .from("bookings")
        .select("id, status, stripe_checkout_session_id")
        .eq("id", bookingId)
        .eq("release_token_hash", releaseTokenHash)
        .maybeSingle();
      if (error) throw toDbError(error);
      return data || null;
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
