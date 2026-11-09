"use strict";

// Date helpers working on ISO strings ("YYYY-MM-DD", "YYYY-MM") so results
// never depend on the server's own time zone. Studio-local "today" is
// computed with Intl in the studio time zone.

const STUDIO_TIMEZONE = "Europe/Madrid";

function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

// Local calendar date ("YYYY-MM-DD") of an instant in a given time zone.
function localDate(instant, timeZone = STUDIO_TIMEZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function todayIn(timeZone = STUDIO_TIMEZONE, now = new Date()) {
  return localDate(now, timeZone);
}

function parseIsoDate(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(isoDate, days) {
  const date = parseIsoDate(isoDate);
  date.setUTCDate(date.getUTCDate() + days);
  return formatIsoDate(date);
}

function monthOf(isoDate) {
  return isoDate.slice(0, 7);
}

function addMonths(month, count) {
  const [y, m] = month.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1 + count, 1));
  return formatIsoDate(date).slice(0, 7);
}

// First and last day of a "YYYY-MM" month.
function monthBounds(month) {
  const [y, m] = month.split("-").map(Number);
  const first = formatIsoDate(new Date(Date.UTC(y, m - 1, 1)));
  const last = formatIsoDate(new Date(Date.UTC(y, m, 0)));
  return { first, last };
}

module.exports = {
  STUDIO_TIMEZONE,
  isValidTimeZone,
  localDate,
  todayIn,
  addDays,
  monthOf,
  addMonths,
  monthBounds,
};
