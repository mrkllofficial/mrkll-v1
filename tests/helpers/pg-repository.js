"use strict";

// Test-only implementation of the repository interface of api/_lib/db.js,
// talking to a local PostgreSQL directly. Every connection switches to the
// `service_role` role, so tests also prove that role has enough privileges.

const { Pool, types } = require("pg");

types.setTypeParser(1082, (value) => value); // DATE as "YYYY-MM-DD"

function createPool(connectionString) {
  return new Pool({ connectionString, max: 4, options: "-c role=service_role" });
}

function createPgRepository(pool) {
  return {
    async getSettings() {
      const { rows } = await pool.query(
        "select timezone, max_advance_days, min_notice_hours, buffer_minutes from public.studio_settings"
      );
      return rows[0];
    },
    async getPackage(packageId) {
      const { rows } = await pool.query(
        "select id, name, duration_minutes, price_cents, currency from public.packages where id = $1 and active",
        [packageId]
      );
      return rows[0] || null;
    },
    async getAvailability(packageId, fromDate, toDate) {
      const { rows } = await pool.query(
        "select day, status, slots from public.get_availability($1, $2::date, $3::date)",
        [packageId, fromDate, toDate]
      );
      return rows;
    },
    async createHold({ packageId, date, startTime, ipHash, releaseTokenHash }) {
      const { rows } = await pool.query(
        "select * from public.create_booking_hold($1, $2::date, $3::time, $4, $5)",
        [packageId, date, startTime, ipHash, releaseTokenHash]
      );
      return rows[0];
    },
    async attachCheckoutSession(bookingId, sessionId) {
      const { rows } = await pool.query("select public.attach_checkout_session($1, $2) as ok", [bookingId, sessionId]);
      return rows[0].ok === true;
    },
    async releaseHold(bookingId, reason, { sessionId = null, releaseTokenHash = null } = {}) {
      const { rows } = await pool.query("select public.release_hold($1, $2, $3, $4) as ok", [
        bookingId, reason, sessionId, releaseTokenHash,
      ]);
      return rows[0].ok === true;
    },
    async findHoldForRelease(bookingId, releaseTokenHash) {
      const { rows } = await pool.query(
        "select id, status, stripe_checkout_session_id from public.bookings where id = $1 and release_token_hash = $2",
        [bookingId, releaseTokenHash]
      );
      return rows[0] || null;
    },
    async beginStripeEvent(eventId, type, bookingId) {
      const { rows } = await pool.query("select public.begin_stripe_event($1, $2, $3) as r", [eventId, type, bookingId]);
      return rows[0].r;
    },
    async finishStripeEvent(eventId) {
      await pool.query("select public.finish_stripe_event($1)", [eventId]);
    },
    async confirmBooking({ bookingId, sessionId, paymentIntent, amountCents, currency, name, email, phone }) {
      const { rows } = await pool.query(
        "select public.confirm_booking($1, $2, $3, $4, $5, $6, $7, $8) as r",
        [bookingId, sessionId, paymentIntent, amountCents, currency, name, email, phone]
      );
      return rows[0].r;
    },
    async recordRefund({ paymentIntent, chargeId, amountCents, amountRefundedCents }) {
      const { rows } = await pool.query("select * from public.record_refund($1, $2, $3, $4)", [
        paymentIntent, chargeId, amountCents, amountRefundedCents,
      ]);
      return rows[0] || null;
    },
    async getBookingDetails(bookingId) {
      const { rows } = await pool.query("select * from public.get_booking_details($1)", [bookingId]);
      return rows[0] || null;
    },
    async claimNotification(key, bookingId, kind) {
      const { rows } = await pool.query("select public.claim_notification($1, $2, $3) as r", [key, bookingId, kind]);
      return rows[0].r === true;
    },
    async completeNotification(key, outcome, providerMessageId, errorMessage) {
      const { rows } = await pool.query("select public.complete_notification($1, $2, $3, $4) as r", [
        key, outcome, providerMessageId, errorMessage,
      ]);
      return rows[0].r === true;
    },
  };
}

module.exports = { createPool, createPgRepository };
