"use strict";

// Business errors raised by the database functions (RAISE EXCEPTION
// '<CODE>' USING ERRCODE = 'P0001') and how the API reports them.
// Anything not listed here is an unexpected failure (HTTP 503).

const DB_ERRORS = {
  PACKAGE_NOT_FOUND: { status: 404, message: "This session package does not exist." },
  INVALID_RANGE: { status: 400, message: "Invalid date range." },
  SLOT_NOT_BOOKABLE: { status: 409, message: "This time can no longer be booked." },
  SLOT_UNAVAILABLE: { status: 409, message: "This time has just been booked. Please choose another one." },
  TOO_MANY_HOLDS: { status: 429, message: "You already have a booking in progress. Complete it or try again in a few minutes." },
  INVALID_TOKEN: { status: 400, message: "Invalid request." },
};

class DbError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "DbError";
    this.code = code;
  }
}

// Returns { status, code, message } for known business errors, else null.
function mapDbError(error) {
  if (!error || error.code !== "P0001") return null;
  const code = String(error.message || "").trim();
  const known = DB_ERRORS[code];
  return known ? { status: known.status, code, message: known.message } : null;
}

module.exports = { DbError, mapDbError, DB_ERRORS };
