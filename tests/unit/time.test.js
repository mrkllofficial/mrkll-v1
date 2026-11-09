"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const time = require("../../api/_lib/time");

test("studio time zone is Europe/Madrid", () => {
  assert.equal(time.STUDIO_TIMEZONE, "Europe/Madrid");
  assert.equal(time.isValidTimeZone("Europe/Madrid"), true);
  assert.equal(time.isValidTimeZone("Mars/Olympus"), false);
});

test("today in Madrid around midnight in winter (UTC+1)", () => {
  assert.equal(time.todayIn("Europe/Madrid", new Date("2026-12-31T22:59:59Z")), "2026-12-31");
  assert.equal(time.todayIn("Europe/Madrid", new Date("2026-12-31T23:00:00Z")), "2027-01-01");
});

test("today in Madrid around midnight in summer (UTC+2)", () => {
  assert.equal(time.todayIn("Europe/Madrid", new Date("2027-06-30T21:59:59Z")), "2027-06-30");
  assert.equal(time.todayIn("Europe/Madrid", new Date("2027-06-30T22:00:00Z")), "2027-07-01");
});

test("today across the DST changes", () => {
  // 28 Mar 2027: clocks go 02:00 -> 03:00; 31 Oct 2027: 03:00 -> 02:00
  assert.equal(time.todayIn("Europe/Madrid", new Date("2027-03-27T23:30:00Z")), "2027-03-28");
  assert.equal(time.todayIn("Europe/Madrid", new Date("2027-10-30T22:30:00Z")), "2027-10-31");
});

test("addDays crosses months, years and leap days", () => {
  assert.equal(time.addDays("2026-11-09", 90), "2027-02-07");
  assert.equal(time.addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(time.addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(time.addDays("2027-03-28", 1), "2027-03-29"); // DST day is still one calendar day
  assert.equal(time.addDays("2027-01-01", -1), "2026-12-31");
});

test("month helpers", () => {
  assert.equal(time.monthOf("2026-12-03"), "2026-12");
  assert.equal(time.addMonths("2026-12", 1), "2027-01");
  assert.equal(time.addMonths("2027-01", -1), "2026-12");
  assert.deepEqual(time.monthBounds("2027-02"), { first: "2027-02-01", last: "2027-02-28" });
  assert.deepEqual(time.monthBounds("2028-02"), { first: "2028-02-01", last: "2028-02-29" });
  assert.deepEqual(time.monthBounds("2026-12"), { first: "2026-12-01", last: "2026-12-31" });
});

test("results do not depend on the server time zone", () => {
  // npm test runs this file under several TZ values; outputs must be identical.
  assert.equal(time.localDate(new Date("2027-03-28T00:30:00Z")), "2027-03-28");
  assert.deepEqual(time.monthBounds("2027-03"), { first: "2027-03-01", last: "2027-03-31" });
  assert.equal(time.addDays("2027-03-27", 2), "2027-03-29");
});
