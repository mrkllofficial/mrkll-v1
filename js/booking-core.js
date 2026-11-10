/* =====================================================================
   MRKLL — booking logic shared by the checkout page and the tests.
   Pure functions only: no DOM, no network. Prices, durations and rules
   always come from the server (/api/availability); nothing here can
   change them.
   ===================================================================== */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.MRKLLBookingCore = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var PACKAGES = ["starter", "pro", "legend"];
  var DEFAULT_PACKAGE = "pro";

  function parsePackage(value) {
    var v = String(value || "").trim().toLowerCase();
    return PACKAGES.indexOf(v) >= 0 ? v : DEFAULT_PACKAGE;
  }

  function isoToUtcDate(iso) {
    var p = String(iso).split("-").map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2] || 1));
  }

  // "2026-12" -> "December 2026"
  function monthLabel(month) {
    return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(isoToUtcDate(month));
  }

  // "2026-12-03" -> "3 December 2026"
  function dateLabel(iso) {
    var parts = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
      .formatToParts(isoToUtcDate(iso));
    var get = function (t) { return parts.filter(function (x) { return x.type === t; })[0].value; };
    return get("day") + " " + get("month") + " " + get("year");
  }

  // amount in cents -> "€<amount>" (decimals only when needed)
  function formatPrice(cents, currency) {
    var whole = Number(cents) % 100 === 0;
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: String(currency || "EUR").toUpperCase(),
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(Number(cents) / 100);
  }

  // 240 -> "4 Hours"
  function formatDuration(minutes) {
    var h = Number(minutes) / 60;
    return h + (h === 1 ? " Hour" : " Hours");
  }

  function sessionLabel(slot) {
    return slot.start + " — " + slot.end;
  }

  function addMonths(month, count) {
    var d = isoToUtcDate(month);
    d.setUTCMonth(d.getUTCMonth() + count);
    return d.toISOString().slice(0, 7);
  }

  // Number of empty cells before day 1 (weeks start on Monday).
  function leadingBlanks(firstIsoDate) {
    return (isoToUtcDate(firstIsoDate).getUTCDay() + 6) % 7;
  }

  var DAY_VIEWS = {
    available: { classes: [], selectable: true, label: "available" },
    unavailable: { classes: ["disabled", "booked-day"], selectable: false, label: "fully booked" },
    closed: { classes: ["disabled", "closed-day"], selectable: false, label: "studio closed" },
    past: { classes: ["past-day"], selectable: false, label: "not available" },
    out_of_range: { classes: ["future-day"], selectable: false, label: "not yet bookable" },
  };

  function dayView(day) {
    var view = DAY_VIEWS[day.status] || DAY_VIEWS.unavailable;
    return {
      classes: view.classes.slice(),
      selectable: view.selectable,
      ariaLabel: dateLabel(day.date) + ", " + view.label,
    };
  }

  function slotView(slot) {
    return {
      classes: slot.available ? [] : ["unavailable"],
      selectable: slot.available === true,
      ariaLabel: sessionLabel(slot) + (slot.available ? ", available" : ", not available"),
    };
  }

  // What to tell the customer for an API error, and what to do next.
  //   refresh: reload the calendar (the slot situation changed)
  function errorFor(status, code) {
    switch (code) {
      case "SLOT_UNAVAILABLE":
        return { message: "This time has just been booked by someone else. Please choose another time.", refresh: true };
      case "SLOT_NOT_BOOKABLE":
        return { message: "This time can no longer be booked. Please choose another time.", refresh: true };
      case "TOO_MANY_HOLDS":
        return { message: "You already have a booking in progress. Complete it or try again in a few minutes.", refresh: false };
      case "PACKAGE_NOT_FOUND":
        return { message: "This session is not available at the moment.", refresh: false };
      case "MONTH_OUT_OF_RANGE":
        return { message: "This month cannot be booked yet.", refresh: true };
      case "INVALID_INPUT":
        return { message: "Please choose a date and a time.", refresh: true };
      default:
        break;
    }
    if (status === 0) {
      return { message: "Connection problem. Please check your connection and try again.", refresh: false };
    }
    if (status === 429) {
      return { message: "Too many attempts. Please wait a moment and try again.", refresh: false };
    }
    return { message: "Booking is temporarily unavailable. Please try again in a moment.", refresh: false };
  }

  return {
    PACKAGES: PACKAGES,
    DEFAULT_PACKAGE: DEFAULT_PACKAGE,
    parsePackage: parsePackage,
    monthLabel: monthLabel,
    dateLabel: dateLabel,
    formatPrice: formatPrice,
    formatDuration: formatDuration,
    sessionLabel: sessionLabel,
    addMonths: addMonths,
    leadingBlanks: leadingBlanks,
    dayView: dayView,
    slotView: slotView,
    errorFor: errorFor,
  };
});
