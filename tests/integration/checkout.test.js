"use strict";

// Hold + Stripe Checkout + release, end to end against the real SQL schema
// (scripts/db-test.sh database). Stripe is replaced by an in-memory fake.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createCheckoutHandler } = require("../../api/create-checkout-session");
const { createReleaseHoldHandler } = require("../../api/release-hold");
const { createAvailabilityHandler } = require("../../api/availability");
const { createPool, createPgRepository } = require("../helpers/pg-repository");
const crypto = require("crypto");
const { createFakeStripe: baseFakeStripe } = require("../helpers/fake-stripe");

// Session ids must be unique across the whole run (UNIQUE in the database).
const createFakeStripe = (options = {}) =>
  baseFakeStripe({ prefix: `cs_test_${crypto.randomBytes(4).toString("hex")}_`, ...options });
const firstSessionId = (stripe) => stripe.calls.create.length && [...stripe.sessions.keys()][0];
const { invoke, postJson, SITE } = require("../helpers/http");
const time = require("../../api/_lib/time");

const DB_URL = process.env.TEST_DATABASE_URL;
const SALT = "integration-salt-0123456789abcdef0123456789";

test("checkout and release against the real database", { skip: !DB_URL && "TEST_DATABASE_URL not set" }, async (t) => {
  const pool = createPool(DB_URL);
  const repo = createPgRepository(pool);
  const site = () => ({ siteUrl: SITE, allowedOrigins: new Set([SITE]) });
  const created = new Set();

  const makeCheckout = (stripe) => createCheckoutHandler({
    getRepository: () => repo, getStripe: () => stripe, getSite: site, getSalt: () => SALT,
  });
  const makeRelease = (stripe) => createReleaseHoldHandler({
    getRepository: () => repo, getStripe: () => stripe, getSite: site,
  });
  const availability = createAvailabilityHandler({ getRepository: () => repo });

  const book = async (handler, body, ip = "203.0.113.1") => {
    const r = await postJson(handler, body, { ip });
    if (r.json && r.json.bookingId) created.add(r.json.bookingId);
    return r;
  };
  const slotsOf = async (pkg, date) => {
    const r = await invoke(availability, { query: { package: pkg, month: date.slice(0, 7) } });
    const day = r.json.days.find((d) => d.date === date);
    return Object.fromEntries(day.slots.map((s) => [s.start, s.available]));
  };
  const booking = async (id) => (await pool.query("select * from bookings where id = $1", [id])).rows[0];

  // Fully free open days inside the window (no holiday, no booking).
  const today = time.todayIn("Europe/Madrid");
  const freeDays = [];
  for (let m = today.slice(0, 7); m <= time.addDays(today, 90).slice(0, 7); m = time.addMonths(m, 1)) {
    const r = await invoke(availability, { query: { package: "starter", month: m } });
    for (const d of r.json.days) {
      if (d.date > time.addDays(today, 2) && d.status === "available" && d.slots.every((s) => s.available)) freeDays.push(d.date);
    }
  }
  assert.ok(freeDays.length >= 6, "enough free days for the tests");
  const [dayA, dayB, dayC, dayD, dayE, dayF] = freeDays;

  t.after(async () => {
    if (created.size) await pool.query("delete from bookings where id = any($1::uuid[])", [[...created]]);
    await pool.end();
  });

  await t.test("successful checkout holds the slot with the database price", async () => {
    const stripe = createFakeStripe();
    const r = await book(makeCheckout(stripe), { packageId: "pro", date: dayA, startTime: "12:30" });
    assert.equal(r.status, 200);
    const b = await booking(r.json.bookingId);
    assert.equal(b.status, "pending_payment");
    assert.equal(b.package_id, "pro");
    assert.equal(b.price_cents, 20000);
    assert.equal(b.stripe_checkout_session_id, firstSessionId(stripe));
    assert.match(b.stripe_checkout_session_id, /^cs_test_/);
    assert.equal(b.reference, r.json.reference);
    assert.match(b.client_ip_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(b.client_ip_hash, "203.0.113.1");
    assert.equal(b.release_token_hash.length, 64);
    const holdMinutes = (b.hold_expires_at - b.created_at) / 60000;
    assert.ok(holdMinutes > 34.9 && holdMinutes <= 35.01, `hold of 35 minutes (${holdMinutes})`);

    const params = stripe.calls.create[0].params;
    assert.equal(params.line_items[0].price_data.unit_amount, 20000);
    assert.equal(params.metadata.booking_id, b.id);
    assert.ok(params.expires_at * 1000 < b.hold_expires_at.getTime() - 120000, "Stripe session ends before the hold");
    assert.ok(params.expires_at * 1000 >= Date.now() + 30 * 60000 - 5000, "at least 30 minutes for Stripe");

    // starts at 12:30 Madrid time, ends 16:30, buffer until 17:00
    const local = (d) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
    assert.equal(local(b.starts_at), "12:30");
    assert.equal(local(b.ends_at), "16:30");
    assert.equal(local(b.blocked_until), "17:00");

    assert.deepEqual(await slotsOf("pro", dayA), { "10:00": false, "12:30": false, "15:00": false, "17:30": true });
    assert.deepEqual(await slotsOf("starter", dayA), { "10:00": true, "12:30": false, "15:00": false, "17:30": true, "20:00": true });
  });

  await t.test("the same slot or an overlapping one cannot be held again", async () => {
    const stripe = createFakeStripe();
    const h = makeCheckout(stripe);
    const same = await book(h, { packageId: "pro", date: dayA, startTime: "12:30" }, "203.0.113.2");
    assert.equal(same.status, 409);
    assert.equal(same.json.error.code, "SLOT_UNAVAILABLE");
    const overlap = await book(h, { packageId: "legend", date: dayA, startTime: "10:00" }, "203.0.113.2");
    assert.equal(overlap.status, 409);
    assert.equal(stripe.calls.create.length, 0, "no Stripe session for refused slots");
    const fits = await book(h, { packageId: "starter", date: dayA, startTime: "17:30" }, "203.0.113.2");
    assert.equal(fits.status, 200, "a slot after the buffer is still free");
  });

  await t.test("invalid slots are refused by the database rules", async () => {
    const h = makeCheckout(createFakeStripe());
    const sunday = (() => { let d = time.addDays(today, 7); while (new Date(`${d}T12:00:00Z`).getUTCDay() !== 0) d = time.addDays(d, 1); return d; })();
    const cases = [
      [{ packageId: "pro", date: dayB, startTime: "11:00" }, 409, "SLOT_NOT_BOOKABLE"], // not in the fixed grid
      [{ packageId: "legend", date: dayB, startTime: "17:30" }, 409, "SLOT_NOT_BOOKABLE"], // would end after 22:00
      [{ packageId: "pro", date: sunday, startTime: "10:00" }, 409, "SLOT_NOT_BOOKABLE"],
      [{ packageId: "pro", date: today, startTime: "20:00" }, 409, "SLOT_NOT_BOOKABLE"], // < 24 h notice
      [{ packageId: "pro", date: time.addDays(today, 95), startTime: "10:00" }, 409, "SLOT_NOT_BOOKABLE"],
      [{ packageId: "vip", date: dayB, startTime: "10:00" }, 404, "PACKAGE_NOT_FOUND"],
    ];
    for (const [body, status, code] of cases) {
      const r = await book(h, body, "203.0.113.3");
      assert.equal(r.status, status, JSON.stringify(body));
      assert.equal(r.json.error.code, code, JSON.stringify(body));
    }
  });

  await t.test("public holidays cannot be booked", async (st) => {
    const { rows } = await pool.query(
      `select (lower(period) at time zone 'Europe/Madrid')::date::text as day from blackout_periods
       where reason like 'Festiu %' and lower(period) > now() + interval '2 days' and lower(period) < now() + interval '89 days'
         and extract(isodow from (lower(period) at time zone 'Europe/Madrid')) <> 7 order by 1 limit 1`
    );
    if (!rows.length) return st.skip("no holiday in the booking window");
    const r = await book(makeCheckout(createFakeStripe()), { packageId: "starter", date: rows[0].day, startTime: "10:00" }, "203.0.113.4");
    assert.equal(r.status, 409);
  });

  await t.test("release: Stripe session expired, slot free again, token required", async () => {
    const stripe = createFakeStripe();
    const r = await book(makeCheckout(stripe), { packageId: "legend", date: dayB, startTime: "10:00" }, "203.0.113.5");
    assert.equal(r.status, 200);
    assert.equal((await slotsOf("legend", dayB))["10:00"], false);
    const release = makeRelease(stripe);

    const wrong = await postJson(release, { bookingId: r.json.bookingId, releaseToken: "A".repeat(43) });
    assert.deepEqual(wrong.json, { released: false });
    assert.equal((await booking(r.json.bookingId)).status, "pending_payment");

    const ok = await postJson(release, { bookingId: r.json.bookingId, releaseToken: r.json.releaseToken });
    assert.deepEqual(ok.json, { released: true });
    assert.deepEqual(stripe.calls.expire, [firstSessionId(stripe)]);
    const b = await booking(r.json.bookingId);
    assert.equal(b.status, "cancelled");
    assert.ok(b.released_at);
    assert.equal((await slotsOf("legend", dayB))["10:00"], true, "slot available again");

    const again = await postJson(release, { bookingId: r.json.bookingId, releaseToken: r.json.releaseToken });
    assert.deepEqual(again.json, { released: false }, "second release is a no-op");
  });

  await t.test("a paid session is never released", async () => {
    const stripe = createFakeStripe();
    const r = await book(makeCheckout(stripe), { packageId: "starter", date: dayC, startTime: "10:00" }, "203.0.113.6");
    stripe.sessions.get(firstSessionId(stripe)).status = "complete"; // customer paid in another tab
    const out = await postJson(makeRelease(stripe), { bookingId: r.json.bookingId, releaseToken: r.json.releaseToken });
    assert.deepEqual(out.json, { released: false });
    assert.equal((await booking(r.json.bookingId)).status, "pending_payment", "left for the webhook to confirm");
  });

  await t.test("Stripe failure: the hold is cancelled at once", async () => {
    const stripe = createFakeStripe({ create: async () => { throw Object.assign(new Error("Stripe down"), { type: "StripeAPIError" }); } });
    const r = await postJson(makeCheckout(stripe), { packageId: "pro", date: dayD, startTime: "10:00" }, { ip: "203.0.113.7" });
    assert.equal(r.status, 502);
    const { rows } = await pool.query(
      "select id, status from bookings where starts_at = (($1::date + time '10:00') at time zone 'Europe/Madrid')", [dayD]
    );
    rows.forEach((row) => created.add(row.id));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "cancelled");
    assert.equal((await slotsOf("pro", dayD))["10:00"], true);
  });

  await t.test("anti-abuse: at most 3 active holds per client IP", async () => {
    const h = makeCheckout(createFakeStripe());
    const ip = "198.51.100.99";
    for (const start of ["10:00", "12:30", "15:00"]) {
      assert.equal((await book(h, { packageId: "starter", date: dayE, startTime: start }, ip)).status, 200);
    }
    const fourth = await book(h, { packageId: "starter", date: dayE, startTime: "17:30" }, ip);
    assert.equal(fourth.status, 429);
    assert.equal(fourth.json.error.code, "TOO_MANY_HOLDS");
    const otherIp = await book(h, { packageId: "starter", date: dayE, startTime: "17:30" }, "198.51.100.100");
    assert.equal(otherIp.status, 200, "another customer is not affected");
  });

  await t.test("an expired hold frees the slot for the next customer", async () => {
    const h = makeCheckout(createFakeStripe());
    const first = await book(h, { packageId: "pro", date: dayF, startTime: "15:00" }, "203.0.113.8");
    assert.equal(first.status, 200);
    await pool.query("update bookings set hold_expires_at = now() - interval '1 second' where id = $1", [first.json.bookingId]);
    assert.equal((await slotsOf("pro", dayF))["15:00"], true);
    const second = await book(h, { packageId: "pro", date: dayF, startTime: "15:00" }, "203.0.113.9");
    assert.equal(second.status, 200);
    assert.equal((await booking(first.json.bookingId)).status, "expired");
  });

  await t.test("concurrent checkouts for the same slot: exactly one wins", async () => {
    const stripe = createFakeStripe();
    const h = makeCheckout(stripe);
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      book(h, { packageId: "legend", date: dayC, startTime: "15:00" }, `192.0.2.${i + 1}`)));
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 409, 409, 409, 409, 409, 409, 409, 409, 409]);
    assert.equal(stripe.calls.create.length, 1, "only the winner reaches Stripe");
  });
});
