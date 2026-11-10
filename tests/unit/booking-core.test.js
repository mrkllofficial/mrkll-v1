"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../../js/booking-core");

test("package from the URL: only the three packages, default Pro", () => {
  assert.equal(core.parsePackage("starter"), "starter");
  assert.equal(core.parsePackage(" LEGEND "), "legend");
  assert.equal(core.parsePackage("pro"), "pro");
  for (const bad of [null, undefined, "", "vip", "<script>", "pro&price=1"]) {
    assert.equal(core.parsePackage(bad), "pro", String(bad));
  }
});

test("labels in the format used by the page", () => {
  assert.equal(core.monthLabel("2026-12"), "December 2026");
  assert.equal(core.monthLabel("2027-01"), "January 2027");
  assert.equal(core.dateLabel("2026-12-03"), "3 December 2026");
  assert.equal(core.dateLabel("2027-03-28"), "28 March 2027");
  assert.equal(core.sessionLabel({ start: "12:30", end: "16:30" }), "12:30 — 16:30");
});

test("price and duration come from the API and are only formatted", () => {
  assert.equal(core.formatPrice(12000, "EUR"), "€120");
  assert.equal(core.formatPrice(20000, "eur"), "€200");
  assert.equal(core.formatPrice(28000, "EUR"), "€280");
  assert.equal(core.formatPrice(12050, "EUR"), "€120.50");
  assert.equal(core.formatDuration(120), "2 Hours");
  assert.equal(core.formatDuration(240), "4 Hours");
  assert.equal(core.formatDuration(360), "6 Hours");
  assert.equal(core.formatDuration(60), "1 Hour");
});

test("month navigation helpers", () => {
  assert.equal(core.addMonths("2026-12", 1), "2027-01");
  assert.equal(core.addMonths("2027-01", -1), "2026-12");
  assert.equal(core.addMonths("2027-02", 0), "2027-02");
});

test("calendar starts on Monday", () => {
  assert.equal(core.leadingBlanks("2026-12-01"), 1); // Tuesday
  assert.equal(core.leadingBlanks("2026-11-01"), 6); // Sunday
  assert.equal(core.leadingBlanks("2027-03-01"), 0); // Monday
  assert.equal(core.leadingBlanks("2027-02-01"), 0);
});

test("day states map to the existing calendar classes", () => {
  const v = (status) => core.dayView({ date: "2026-12-03", status, slots: [] });
  assert.deepEqual(v("available"), { classes: [], selectable: true, ariaLabel: "3 December 2026, available" });
  assert.deepEqual(v("unavailable").classes, ["disabled", "booked-day"]);
  assert.deepEqual(v("closed").classes, ["disabled", "closed-day"]);
  assert.deepEqual(v("past").classes, ["past-day"]);
  assert.deepEqual(v("out_of_range").classes, ["future-day"]);
  for (const s of ["unavailable", "closed", "past", "out_of_range", "unknown"]) {
    assert.equal(v(s).selectable, false, s);
  }
});

test("slot states", () => {
  assert.deepEqual(core.slotView({ start: "10:00", end: "14:00", available: true }), {
    classes: [], selectable: true, ariaLabel: "10:00 — 14:00, available",
  });
  const busy = core.slotView({ start: "12:30", end: "16:30", available: false });
  assert.deepEqual(busy.classes, ["unavailable"]);
  assert.equal(busy.selectable, false);
});

test("error messages and follow-up actions", () => {
  assert.equal(core.errorFor(409, "SLOT_UNAVAILABLE").refresh, true);
  assert.match(core.errorFor(409, "SLOT_UNAVAILABLE").message, /just been booked/);
  assert.equal(core.errorFor(409, "SLOT_NOT_BOOKABLE").refresh, true);
  assert.equal(core.errorFor(429, "TOO_MANY_HOLDS").refresh, false);
  assert.match(core.errorFor(0).message, /Connection problem/);
  assert.match(core.errorFor(429).message, /wait a moment/);
  assert.match(core.errorFor(503, "SERVICE_UNAVAILABLE").message, /temporarily unavailable/);
  assert.match(core.errorFor(502, "PAYMENT_PROVIDER_ERROR").message, /temporarily unavailable/);
  // Never shows server internals
  assert.doesNotMatch(core.errorFor(500, "SOMETHING_INTERNAL").message, /SOMETHING_INTERNAL/);
});

test("the browser module has no price, duration or rule of its own", () => {
  const fs = require("fs");
  const src = fs.readFileSync(require.resolve("../../js/booking.js"), "utf8") + fs.readFileSync(require.resolve("../../js/booking-core.js"), "utf8");
  assert.doesNotMatch(src, /12000|20000|28000|€120|€200|€280/, "no hard-coded prices");
  assert.doesNotMatch(src, /"10:00"|"12:30"|"15:00"/, "no hard-coded time slots");
  assert.doesNotMatch(src, /bookedDays|bookedSlots/, "no simulated availability");
  assert.doesNotMatch(src, /innerHTML\s*=(?!\s*"";)/, "innerHTML only used to empty containers");
});
