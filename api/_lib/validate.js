"use strict";

// Strict input validation. Each parser returns the normalised value, or
// null when the input is invalid. Non-string input (e.g. repeated query
// parameters) is always invalid.

const PACKAGE_ID_RE = /^[a-z0-9_-]{1,32}$/;
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DATE_RE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parsePackageId(value) {
  if (typeof value !== "string") return null;
  const id = value.trim().toLowerCase();
  return PACKAGE_ID_RE.test(id) ? id : null;
}

function parseMonth(value) {
  if (typeof value !== "string") return null;
  const match = MONTH_RE.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  if (year < 2020 || year > 2100) return null;
  return match[0];
}

// Real calendar date only (rejects 2026-02-30).
function parseIsoDate(value) {
  if (typeof value !== "string") return null;
  const match = DATE_RE.exec(value.trim());
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return null;
  }
  if (y < 2020 || y > 2100) return null;
  return match[0];
}

function parseTime(value) {
  if (typeof value !== "string") return null;
  const match = TIME_RE.exec(value.trim());
  return match ? match[0] : null;
}

module.exports = { parsePackageId, parseMonth, parseIsoDate, parseTime };
