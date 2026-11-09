"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createAvailabilityHandler } = require("../../api/availability");
const { createSupabaseRepository } = require("../../api/_lib/db");
const { ConfigError } = require("../../api/_lib/config");
const { invoke } = require("../helpers/http");

const NOW = new Date("2026-11-09T10:00:00Z"); // Monday, 11:00 in Madrid

function fakeRepository(overrides = {}) {
  const calls = [];
  const repo = {
    calls,
    async getSettings() {
      return { timezone: "Europe/Madrid", max_advance_days: 90, min_notice_hours: 24, buffer_minutes: 30 };
    },
    async getPackage(id) {
      const packages = {
        starter: { id: "starter", name: "Recording Starter", duration_minutes: 120, price_cents: 12000, currency: "eur" },
        pro: { id: "pro", name: "Recording Pro", duration_minutes: 240, price_cents: 20000, currency: "eur" },
        legend: { id: "legend", name: "Recording Legend", duration_minutes: 360, price_cents: 28000, currency: "eur" },
      };
      return packages[id] || null;
    },
    async getAvailability(id, from, to) {
      calls.push({ id, from, to });
      return [
        { day: "2026-12-07", status: "available", slots: [{ start: "10:00", end: "14:00", available: true }, { start: "12:30", end: "16:30", available: false }] },
        { day: "2026-12-08", status: "closed", slots: [] },
      ];
    },
    ...overrides,
  };
  return repo;
}

function handlerWith(repo) {
  return createAvailabilityHandler({ getRepository: () => repo, now: () => NOW });
}

test("only GET is allowed", async () => {
  const r = await invoke(handlerWith(fakeRepository()), { method: "POST", query: { package: "pro" } });
  assert.equal(r.status, 405);
  assert.equal(r.headers.allow, "GET");
  assert.equal(r.json.error.code, "METHOD_NOT_ALLOWED");
});

test("package is required and validated", async () => {
  for (const query of [{}, { package: "" }, { package: "../etc" }, { package: ["pro", "legend"] }]) {
    const r = await invoke(handlerWith(fakeRepository()), { query });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, "INVALID_INPUT");
  }
});

test("month format is validated", async () => {
  for (const month of ["2026-13", "2026-1", "dicembre", ""]) {
    const r = await invoke(handlerWith(fakeRepository()), { query: { package: "pro", month } });
    assert.equal(r.status, 400, month);
    assert.equal(r.json.error.code, "INVALID_INPUT");
  }
});

test("unknown package returns 404", async () => {
  const r = await invoke(handlerWith(fakeRepository()), { query: { package: "vip" } });
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, "PACKAGE_NOT_FOUND");
});

test("defaults to the current studio month and queries the whole month", async () => {
  const repo = fakeRepository();
  const r = await invoke(handlerWith(repo), { query: { package: "pro" } });
  assert.equal(r.status, 200);
  assert.equal(r.json.month, "2026-11");
  assert.equal(r.json.today, "2026-11-09");
  assert.deepEqual(repo.calls, [{ id: "pro", from: "2026-11-01", to: "2026-11-30" }]);
});

test("navigation window: current month to month of today + 90 days", async () => {
  const r = await invoke(handlerWith(fakeRepository()), { query: { package: "pro", month: "2026-12" } });
  assert.equal(r.json.minMonth, "2026-11");
  assert.equal(r.json.maxMonth, "2027-02"); // 2026-11-09 + 90 days = 2027-02-07
  assert.equal(r.status, 200);

  for (const month of ["2026-10", "2027-03"]) {
    const out = await invoke(handlerWith(fakeRepository()), { query: { package: "pro", month } });
    assert.equal(out.status, 400, month);
    assert.equal(out.json.error.code, "MONTH_OUT_OF_RANGE");
    assert.equal(out.json.error.minMonth, "2026-11");
    assert.equal(out.json.error.maxMonth, "2027-02");
  }
});

test("response shape: package info, days and slots", async () => {
  const r = await invoke(handlerWith(fakeRepository()), { query: { package: "pro", month: "2026-12" } });
  assert.equal(r.json.timezone, "Europe/Madrid");
  assert.deepEqual(r.json.package, {
    id: "pro", name: "Recording Pro", durationMinutes: 240, priceCents: 20000, currency: "EUR",
  });
  assert.deepEqual(r.json.days[0], {
    date: "2026-12-07",
    status: "available",
    slots: [{ start: "10:00", end: "14:00", available: true }, { start: "12:30", end: "16:30", available: false }],
  });
  assert.deepEqual(r.json.days[1], { date: "2026-12-08", status: "closed", slots: [] });
});

test("the three packages report the approved durations and prices", async () => {
  const expected = { starter: [120, 12000], pro: [240, 20000], legend: [360, 28000] };
  for (const [id, [minutes, cents]] of Object.entries(expected)) {
    const r = await invoke(handlerWith(fakeRepository()), { query: { package: id } });
    assert.equal(r.json.package.durationMinutes, minutes);
    assert.equal(r.json.package.priceCents, cents);
  }
});

test("responses are never cached", async () => {
  const r = await invoke(handlerWith(fakeRepository()), { query: { package: "pro" } });
  assert.equal(r.headers["cache-control"], "no-store");
  assert.equal(r.headers["content-type"], "application/json; charset=utf-8");
});

test("month boundaries follow Madrid time, not UTC", async () => {
  // 31 Dec 2026 23:30 in Madrid is still 22:30 UTC on 31 Dec, and
  // 1 Jan 2027 00:30 in Madrid is 23:30 UTC on 31 Dec.
  const repo = fakeRepository();
  const h = createAvailabilityHandler({ getRepository: () => repo, now: () => new Date("2026-12-31T23:30:00Z") });
  const r = await invoke(h, { query: { package: "pro" } });
  assert.equal(r.json.today, "2027-01-01");
  assert.equal(r.json.month, "2027-01");
  assert.equal(r.json.minMonth, "2027-01");
});

test("missing configuration returns 500 without details", async () => {
  const h = createAvailabilityHandler({
    getRepository: () => { throw new ConfigError("Missing environment variable SUPABASE_SECRET_KEY"); },
    now: () => NOW,
  });
  const r = await invoke(h, { query: { package: "pro" } });
  assert.equal(r.status, 500);
  assert.equal(r.json.error.code, "CONFIG_ERROR");
  assert.doesNotMatch(r.body, /SUPABASE/);
});

test("database failure returns 503 without leaking internals", async () => {
  const repo = fakeRepository({
    async getAvailability() {
      const e = new Error("connection to server at 10.0.0.1 failed: password authentication failed");
      e.code = "08006";
      throw e;
    },
  });
  const r = await invoke(handlerWith(repo), { query: { package: "pro" } });
  assert.equal(r.status, 503);
  assert.equal(r.json.error.code, "SERVICE_UNAVAILABLE");
  assert.doesNotMatch(r.body, /password|10\.0\.0\.1/);
});

test("business errors from the database are mapped", async () => {
  const repo = fakeRepository({
    async getAvailability() {
      const e = new Error("PACKAGE_NOT_FOUND");
      e.code = "P0001";
      throw e;
    },
  });
  const r = await invoke(handlerWith(repo), { query: { package: "pro" } });
  assert.equal(r.status, 404);
});

test("supabase repository calls the right RPC and tables", async () => {
  const log = [];
  const builder = (table) => {
    const q = {
      select(cols) { log.push(["select", table, cols]); return q; },
      eq(col, val) { log.push(["eq", table, col, val]); return q; },
      async single() { return { data: { timezone: "Europe/Madrid", max_advance_days: 90 }, error: null }; },
      async maybeSingle() { return { data: null, error: null }; },
    };
    return q;
  };
  const client = {
    from: builder,
    async rpc(name, args) {
      log.push(["rpc", name, args]);
      return { data: null, error: { message: "SLOT_UNAVAILABLE", code: "P0001" } };
    },
  };
  const repo = createSupabaseRepository(client);
  assert.equal((await repo.getSettings()).timezone, "Europe/Madrid");
  assert.equal(await repo.getPackage("pro"), null);
  await assert.rejects(repo.getAvailability("pro", "2026-12-01", "2026-12-31"), (e) => e.code === "P0001" && e.message === "SLOT_UNAVAILABLE");
  assert.deepEqual(log.find((l) => l[0] === "rpc"), ["rpc", "get_availability", { p_package_id: "pro", p_from: "2026-12-01", p_to: "2026-12-31" }]);
  assert.ok(log.some((l) => l[0] === "eq" && l[1] === "packages" && l[2] === "active" && l[3] === true), "only active packages");
});
