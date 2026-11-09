"use strict";

// GET /api/availability?package=pro&month=2026-12
//
// Real availability for one package and one month, in studio-local time
// (Europe/Madrid). `month` is optional and defaults to the current month.
//
// 200 {
//   timezone, today, month, minMonth, maxMonth,
//   package: { id, name, durationMinutes, priceCents, currency },
//   days: [{ date: "2026-12-03",
//            status: "available" | "unavailable" | "closed" | "past" | "out_of_range",
//            slots: [{ start: "10:00", end: "12:00", available: true }] }]
// }
// 400 INVALID_INPUT | MONTH_OUT_OF_RANGE   404 PACKAGE_NOT_FOUND
// 405 METHOD_NOT_ALLOWED                   500 CONFIG_ERROR   503 SERVICE_UNAVAILABLE

const { sendJson, sendError, allowMethods, getQuery, log } = require("./_lib/http");
const { parsePackageId, parseMonth } = require("./_lib/validate");
const { todayIn, addDays, monthOf, monthBounds, isValidTimeZone } = require("./_lib/time");
const { mapDbError } = require("./_lib/errors");
const { ConfigError } = require("./_lib/config");
const db = require("./_lib/db");

const DAY_STATUSES = new Set(["available", "unavailable", "closed", "past", "out_of_range"]);

function toIsoDate(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function mapDay(row) {
  const status = DAY_STATUSES.has(row.status) ? row.status : "unavailable";
  const slots = Array.isArray(row.slots) ? row.slots : [];
  return {
    date: toIsoDate(row.day),
    status,
    slots: slots.map((slot) => ({
      start: String(slot.start),
      end: String(slot.end),
      available: slot.available === true,
    })),
  };
}

function createAvailabilityHandler({ getRepository = db.getRepository, now = () => new Date() } = {}) {
  return async function availabilityHandler(req, res) {
    if (!allowMethods(req, res, ["GET"])) return;

    const query = getQuery(req);
    const packageId = parsePackageId(query.package);
    if (!packageId) {
      return sendError(res, 400, "INVALID_INPUT", "A valid package is required.");
    }
    const requestedMonth = query.month === undefined ? undefined : parseMonth(query.month);
    if (requestedMonth === null) {
      return sendError(res, 400, "INVALID_INPUT", "Month must use the YYYY-MM format.");
    }

    let repository;
    try {
      repository = getRepository();
    } catch (error) {
      log("error", "availability_config_error", {
        message: error instanceof ConfigError ? error.message : "Unable to initialise data access",
      });
      return sendError(res, 500, "CONFIG_ERROR", "Booking is temporarily unavailable.");
    }

    try {
      const [settings, pkg] = await Promise.all([
        repository.getSettings(),
        repository.getPackage(packageId),
      ]);

      if (!pkg) {
        return sendError(res, 404, "PACKAGE_NOT_FOUND", "This session package does not exist.");
      }
      if (!settings || !isValidTimeZone(settings.timezone)) {
        throw new Error("Studio settings missing or invalid");
      }

      const timezone = settings.timezone;
      const today = todayIn(timezone, now());
      const minMonth = monthOf(today);
      const maxMonth = monthOf(addDays(today, Number(settings.max_advance_days)));
      const month = requestedMonth || minMonth;

      if (month < minMonth || month > maxMonth) {
        return sendError(res, 400, "MONTH_OUT_OF_RANGE", "This month cannot be booked.", { minMonth, maxMonth });
      }

      const { first, last } = monthBounds(month);
      const rows = await repository.getAvailability(packageId, first, last);

      return sendJson(res, 200, {
        timezone,
        today,
        month,
        minMonth,
        maxMonth,
        package: {
          id: pkg.id,
          name: pkg.name,
          durationMinutes: Number(pkg.duration_minutes),
          priceCents: Number(pkg.price_cents),
          currency: String(pkg.currency).toUpperCase(),
        },
        days: rows.map(mapDay),
      });
    } catch (error) {
      const known = mapDbError(error);
      if (known) {
        return sendError(res, known.status, known.code, known.message);
      }
      log("error", "availability_failed", {
        message: error && error.message,
        code: error && error.code,
        packageId,
      });
      return sendError(res, 503, "SERVICE_UNAVAILABLE", "Availability is temporarily unavailable. Please try again.");
    }
  };
}

module.exports = createAvailabilityHandler();
module.exports.createAvailabilityHandler = createAvailabilityHandler;
