"use strict";

// End-to-end check of GET /api/availability against the real SQL schema,
// seed and holidays, on the throw-away database created by scripts/db-test.sh.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createAvailabilityHandler } = require("../../api/availability");
const { createPool, createPgRepository } = require("../helpers/pg-repository");
const { invoke } = require("../helpers/http");
const time = require("../../api/_lib/time");

const DB_URL = process.env.TEST_DATABASE_URL;
const GRID = {
  starter: [["10:00", "12:00"], ["12:30", "14:30"], ["15:00", "17:00"], ["17:30", "19:30"], ["20:00", "22:00"]],
  pro: [["10:00", "14:00"], ["12:30", "16:30"], ["15:00", "19:00"], ["17:30", "21:30"]],
  legend: [["10:00", "16:00"], ["12:30", "18:30"], ["15:00", "21:00"]],
};

const isoWeekday = (iso) => ((new Date(`${iso}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;

test("availability API against the real database", { skip: !DB_URL && "TEST_DATABASE_URL not set" }, async (t) => {
  const pool = createPool(DB_URL);
  const handler = createAvailabilityHandler({ getRepository: () => createPgRepository(pool) });
  const today = time.todayIn("Europe/Madrid");
  const get = (query) => invoke(handler, { query });

  // all months the customer can navigate to
  const first = await get({ package: "pro" });
  const months = [];
  for (let m = first.json.minMonth; m <= first.json.maxMonth; m = time.addMonths(m, 1)) months.push(m);
  const allDays = {};
  for (const id of Object.keys(GRID)) {
    allDays[id] = [];
    for (const month of months) {
      const r = await get({ package: id, month });
      assert.equal(r.status, 200, `${id} ${month}`);
      allDays[id].push(...r.json.days);
    }
  }
  const holidayRows = (await pool.query(
    "select (lower(period) at time zone 'Europe/Madrid')::date::text as day from blackout_periods where reason like 'Festiu %'"
  )).rows.map((r) => r.day);

  t.after(async () => {
    await pool.query("delete from bookings where client_ip_hash like 'it-%'");
    await pool.end();
  });

  await t.test("connections run as service_role (the role used by Supabase)", async () => {
    assert.equal((await pool.query("select current_user")).rows[0].current_user, "service_role");
  });

  await t.test("response metadata", () => {
    assert.equal(first.status, 200);
    assert.equal(first.json.timezone, "Europe/Madrid");
    assert.equal(first.json.today, today);
    assert.equal(first.json.minMonth, today.slice(0, 7));
    assert.equal(first.json.maxMonth, time.addDays(today, 90).slice(0, 7));
  });

  await t.test("one entry per calendar day of the month", async () => {
    const r = await get({ package: "starter", month: first.json.minMonth });
    const { first: d1, last } = time.monthBounds(r.json.month);
    assert.equal(r.json.days.length, Number(last.slice(8)));
    assert.equal(r.json.days[0].date, d1);
  });

  await t.test("months outside the window are refused", async () => {
    const before = await get({ package: "pro", month: time.addMonths(first.json.minMonth, -1) });
    const after = await get({ package: "pro", month: time.addMonths(first.json.maxMonth, 1) });
    assert.equal(before.status, 400);
    assert.equal(after.status, 400);
    assert.equal(after.json.error.code, "MONTH_OUT_OF_RANGE");
  });

  await t.test("packages: approved names, durations and prices", async () => {
    const expected = {
      starter: ["Recording Starter", 120, 12000],
      pro: ["Recording Pro", 240, 20000],
      legend: ["Recording Legend", 360, 28000],
    };
    for (const [id, [name, minutes, cents]] of Object.entries(expected)) {
      const r = await get({ package: id });
      assert.deepEqual(r.json.package, { id, name, durationMinutes: minutes, priceCents: cents, currency: "EUR" });
    }
    assert.equal((await get({ package: "vip" })).status, 404);
  });

  await t.test("day statuses: past, closed on Sundays, out of range after 90 days", () => {
    const limit = time.addDays(today, 90);
    for (const day of allDays.pro) {
      if (day.date < today) assert.equal(day.status, "past", day.date);
      else if (day.date > limit) assert.equal(day.status, "out_of_range", day.date);
      else if (isoWeekday(day.date) === 7) assert.equal(day.status, "closed", day.date);
      if (["past", "out_of_range", "closed"].includes(day.status)) assert.deepEqual(day.slots, [], day.date);
    }
  });

  await t.test("fixed start times of each package on open days", () => {
    for (const [id, grid] of Object.entries(GRID)) {
      const open = allDays[id].filter((d) => d.status === "available" || d.status === "unavailable");
      assert.ok(open.length > 20, `${id}: open days found`);
      for (const day of open) {
        assert.deepEqual(day.slots.map((s) => [s.start, s.end]), grid, `${id} ${day.date}`);
      }
    }
  });

  await t.test("24-hour notice: nothing bookable today, and tomorrow only after now + 24h", (st) => {
    const todayRow = allDays.starter.find((d) => d.date === today);
    if (todayRow && todayRow.slots.length) {
      assert.ok(todayRow.slots.every((s) => !s.available), "today");
    }
    const offset = (d) => new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Madrid", timeZoneName: "shortOffset" })
      .formatToParts(d).find((p) => p.type === "timeZoneName").value;
    const now = new Date();
    if (offset(now) !== offset(new Date(now.getTime() + 864e5))) {
      st.skip("DST change within the next 24h");
      return;
    }
    const nowLocal = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
    const tomorrow = allDays.starter.find((d) => d.date === time.addDays(today, 1));
    for (const s of (tomorrow && tomorrow.slots) || []) {
      if (s.start < nowLocal) assert.equal(s.available, false, `tomorrow ${s.start} is within 24h`);
    }
  });

  await t.test("public holidays in the window are closed for every package", (st) => {
    const limit = time.addDays(today, 90);
    const inWindow = holidayRows.filter((d) => d >= today && d <= limit);
    if (inWindow.length === 0) {
      st.skip("no holiday inside the current 90-day window");
      return;
    }
    for (const id of Object.keys(GRID)) {
      for (const date of inWindow) {
        const day = allDays[id].find((d) => d.date === date);
        assert.equal(day.status, "closed", `${id} ${date}`);
        assert.deepEqual(day.slots, []);
      }
    }
  });

  await t.test("a hold makes overlapping slots unavailable for all packages", async () => {
    const target = allDays.pro.find((d) => d.status === "available" && d.date > time.addDays(today, 3) && d.slots.every((s) => s.available));
    assert.ok(target, "a fully free day exists");
    await pool.query(
      "select * from create_booking_hold('pro', $1::date, '12:30', 'it-1', repeat(md5('it-1'), 2))",
      [target.date]
    );
    const month = target.date.slice(0, 7);
    const day = async (id) => (await get({ package: id, month })).json.days.find((d) => d.date === target.date);
    const flags = async (id) => Object.fromEntries((await day(id)).slots.map((s) => [s.start, s.available]));

    // pro 12:30-16:30 + 30 min buffer blocks the sala until 17:00
    assert.deepEqual(await flags("pro"), { "10:00": false, "12:30": false, "15:00": false, "17:30": true });
    assert.deepEqual(await flags("starter"), { "10:00": true, "12:30": false, "15:00": false, "17:30": true, "20:00": true });
    assert.deepEqual(await flags("legend"), { "10:00": false, "12:30": false, "15:00": false });
    assert.equal((await day("legend")).status, "unavailable");
    assert.equal((await day("starter")).status, "available");
  });
});
