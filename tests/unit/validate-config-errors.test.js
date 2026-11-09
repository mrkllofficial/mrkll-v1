"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const v = require("../../api/_lib/validate");
const { getSupabaseConfig, ConfigError } = require("../../api/_lib/config");
const { mapDbError } = require("../../api/_lib/errors");

test("package id validation", () => {
  assert.equal(v.parsePackageId("pro"), "pro");
  assert.equal(v.parsePackageId(" Legend "), "legend");
  assert.equal(v.parsePackageId(""), null);
  assert.equal(v.parsePackageId("pro;drop table"), null);
  assert.equal(v.parsePackageId("x".repeat(33)), null);
  assert.equal(v.parsePackageId(["pro", "legend"]), null);
  assert.equal(v.parsePackageId(undefined), null);
});

test("month validation", () => {
  assert.equal(v.parseMonth("2026-12"), "2026-12");
  assert.equal(v.parseMonth("2026-13"), null);
  assert.equal(v.parseMonth("2026-1"), null);
  assert.equal(v.parseMonth("12-2026"), null);
  assert.equal(v.parseMonth("1999-01"), null);
  assert.equal(v.parseMonth(["2026-12"]), null);
});

test("date and time validation", () => {
  assert.equal(v.parseIsoDate("2026-12-03"), "2026-12-03");
  assert.equal(v.parseIsoDate("2027-02-29"), null);
  assert.equal(v.parseIsoDate("2028-02-29"), "2028-02-29");
  assert.equal(v.parseIsoDate("2026-12-3"), null);
  assert.equal(v.parseIsoDate("3 December 2026"), null);
  assert.equal(v.parseTime("10:00"), "10:00");
  assert.equal(v.parseTime("12:30"), "12:30");
  assert.equal(v.parseTime("24:00"), null);
  assert.equal(v.parseTime("9:00"), null);
});

test("supabase config: required, https, secret key only", () => {
  assert.throws(() => getSupabaseConfig({}), ConfigError);
  assert.throws(() => getSupabaseConfig({ SUPABASE_URL: "https://x.supabase.co" }), /SUPABASE_SECRET_KEY/);
  assert.throws(
    () => getSupabaseConfig({ SUPABASE_URL: "http://x.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_x" }),
    /https/
  );
  assert.throws(
    () => getSupabaseConfig({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_SECRET_KEY: "sb_publishable_x" }),
    /publishable/
  );
  assert.deepEqual(
    getSupabaseConfig({ SUPABASE_URL: "https://x.supabase.co/", SUPABASE_SECRET_KEY: " sb_secret_x " }),
    { url: "https://x.supabase.co", secretKey: "sb_secret_x" }
  );
});

test("database business errors are mapped to HTTP codes", () => {
  assert.deepEqual(mapDbError({ code: "P0001", message: "SLOT_UNAVAILABLE" }).status, 409);
  assert.deepEqual(mapDbError({ code: "P0001", message: "TOO_MANY_HOLDS" }).status, 429);
  assert.deepEqual(mapDbError({ code: "P0001", message: "PACKAGE_NOT_FOUND" }).status, 404);
  assert.equal(mapDbError({ code: "P0001", message: "SOMETHING_ELSE" }), null);
  assert.equal(mapDbError({ code: "42501", message: "permission denied" }), null);
  assert.equal(mapDbError(null), null);
});
