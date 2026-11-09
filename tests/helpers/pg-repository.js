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
  };
}

module.exports = { createPool, createPgRepository };
