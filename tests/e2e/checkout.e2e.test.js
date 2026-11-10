"use strict";

// Browser tests (Chromium via Playwright) of checkout.html with the real API
// handlers and the real SQL schema. Stripe is a local fake page with "Pay"
// and "Cancel" links that redirect exactly like Stripe Checkout does.

const test = require("node:test");
const assert = require("node:assert/strict");
const { createPool, createPgRepository } = require("../helpers/pg-repository");
const { startTestServer } = require("../helpers/test-server");
const time = require("../../api/_lib/time");
const core = require("../../js/booking-core");

const DB_URL = process.env.TEST_DATABASE_URL;
let chromium = null;
try {
  ({ chromium } = require("playwright"));
} catch {
  chromium = null;
}

const GRID = {
  starter: ["10:00", "12:30", "15:00", "17:30", "20:00"],
  pro: ["10:00", "12:30", "15:00", "17:30"],
  legend: ["10:00", "12:30", "15:00"],
};

test("checkout page in a real browser", { skip: (!DB_URL && "TEST_DATABASE_URL not set") || (!chromium && "playwright not installed") }, async (t) => {
  const pool = createPool(DB_URL);
  const repo = createPgRepository(pool);
  const server = await startTestServer({ repository: repo });
  const browser = await chromium.launch();
  const startedAt = new Date();
  const today = time.todayIn("Europe/Madrid");
  const used = new Set();

  t.after(async () => {
    await browser.close();
    await server.close();
    await pool.query("delete from bookings where created_at >= $1", [startedAt]);
    await pool.end();
  });

  // Each context is a different customer (own IP), as the server limits
  // active holds per client IP (anti-abuse, verified separately below).
  let customer = 0;
  const newCustomer = (options = {}) => {
    customer += 1;
    return browser.newContext({ ...options, extraHTTPHeaders: { "x-real-ip": `198.18.0.${customer}` } });
  };

  async function openPage({ width = 1280, height = 900, pkg = "pro" } = {}) {
    const context = await newCustomer({ viewport: { width, height } });
    const page = await context.newPage();
    // Fonts come from Google; not needed for these checks (and keeps tests offline).
    await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    page.errors = [];
    page.on("pageerror", (e) => page.errors.push(e.message));
    await page.goto(`${server.base}/checkout.html?package=${pkg}`);
    await idle(page);
    return page;
  }

  const idle = (page) => page.waitForFunction(() => {
    const p = document.querySelector(".calendar-panel");
    return p && !p.classList.contains("is-loading") && document.querySelectorAll("#calendarDays [data-date]").length > 0;
  });

  // Picks a day (and optionally a start) still free and not used by another test.
  async function pickSlot(page, start) {
    for (let i = 0; i < 4; i++) {
      const dates = await page.$$eval("#calendarDays [data-date]:not([disabled])", (els) => els.map((e) => e.dataset.date));
      for (const date of dates) {
        if (date <= time.addDays(today, 2)) continue;
        await page.click(`[data-date="${date}"]`);
        const free = await page.$$eval("#timeSlots .slot:not([disabled])", (els) => els.map((e) => e.dataset.start));
        const choice = start ? free.find((s) => s === start) : free[0];
        if (choice && !used.has(`${date} ${choice}`)) {
          used.add(`${date} ${choice}`);
          await page.click(`#timeSlots [data-start="${choice}"]`);
          return { date, start: choice };
        }
      }
      if (await page.isDisabled("#nextMonth")) break;
      await page.click("#nextMonth");
      await idle(page);
    }
    throw new Error("no free slot found");
  }

  const bookingFor = async (date, start) => (await pool.query(
    "select * from bookings where starts_at = (($1::date + $2::time) at time zone 'Europe/Madrid') and created_at >= $3 order by created_at desc",
    [date, start, startedAt]
  )).rows;

  await t.test("initial state: current month, Pro package from the API, nothing selected", async () => {
    const page = await openPage();
    assert.equal((await page.textContent("#monthTitle")).trim(), core.monthLabel(today.slice(0, 7)));
    assert.equal(await page.isDisabled("#prevMonth"), true, "cannot go before the current month");
    assert.equal((await page.textContent("#package-name")).trim(), "Recording Pro");
    assert.equal((await page.textContent("#package-duration")).trim(), "4 Hours");
    assert.equal((await page.textContent("#package-price")).trim(), "€200");
    assert.equal(await page.getAttribute('[data-package="pro"]', "aria-pressed"), "true");
    assert.equal((await page.textContent("#selected-date")).trim(), "Not selected");
    assert.equal(await page.isDisabled("#continueBtn"), true);
    assert.equal((await page.textContent("#timeSlots")).trim(), "Select a date to see the available times.");

    // Every Sunday is closed; past days are not selectable.
    const states = await page.$$eval("#calendarDays [data-date]", (els) => els.map((e) => ({ date: e.dataset.date, cls: e.className, disabled: e.disabled })));
    for (const d of states) {
      const sunday = new Date(`${d.date}T12:00:00Z`).getUTCDay() === 0;
      if (d.date < today) assert.ok(d.disabled && /past-day/.test(d.cls), d.date);
      else if (sunday) assert.ok(d.disabled && /closed-day/.test(d.cls), d.date);
    }
    assert.deepEqual(page.errors, []);
    await page.context().close();
  });

  await t.test("month navigation stays inside the 90-day window", async () => {
    const page = await openPage();
    const maxMonth = time.addDays(today, 90).slice(0, 7);
    const seen = [(await page.textContent("#monthTitle")).trim()];
    while (!(await page.isDisabled("#nextMonth"))) {
      await page.click("#nextMonth");
      await idle(page);
      seen.push((await page.textContent("#monthTitle")).trim());
      assert.ok(seen.length < 6, "bounded");
    }
    assert.equal(seen[seen.length - 1], core.monthLabel(maxMonth));
    // days after today + 90 are not bookable
    const late = await page.$$eval("#calendarDays [data-date]", (els) => els.filter((e) => /future-day/.test(e.className)).map((e) => e.dataset.date));
    for (const d of late) assert.ok(d > time.addDays(today, 90), d);
    assert.equal(await page.isDisabled("#prevMonth"), false);
    await page.click("#prevMonth");
    await idle(page);
    assert.equal((await page.textContent("#monthTitle")).trim(), seen[seen.length - 2]);
    await page.context().close();
  });

  await t.test("public holidays are shown as closed", async (st) => {
    const { rows } = await pool.query(
      `select (lower(period) at time zone 'Europe/Madrid')::date::text as day from blackout_periods
       where reason like 'Festiu %' and lower(period) > now() and lower(period) < now() + interval '89 days'
         and extract(isodow from (lower(period) at time zone 'Europe/Madrid')) <> 7 order by 1 limit 1`
    );
    if (!rows.length) return st.skip("no holiday in the window");
    const page = await openPage();
    while (!(await page.$(`[data-date="${rows[0].day}"]`))) {
      await page.click("#nextMonth");
      await idle(page);
    }
    const cell = await page.$(`[data-date="${rows[0].day}"]`);
    assert.match(await cell.getAttribute("class"), /closed-day/);
    assert.equal(await cell.isDisabled(), true);
    assert.match(await cell.getAttribute("aria-label"), /studio closed/);
    await page.context().close();
  });

  await t.test("changing the day clears the time; changing package reloads slots, price and duration", async () => {
    const page = await openPage();
    const { date } = await pickSlot(page);
    assert.equal(await page.isDisabled("#continueBtn"), false);

    // another day -> time cleared (old bug: the previous time stayed selected)
    const other = await page.$$eval("#calendarDays [data-date]:not([disabled])", (els, d) => els.map((e) => e.dataset.date).find((x) => x !== d), date);
    await page.click(`[data-date="${other}"]`);
    assert.equal((await page.textContent("#session-time")).trim(), "Not selected");
    assert.equal(await page.isDisabled("#continueBtn"), true);

    for (const [pkg, name, duration, price] of [["starter", "Recording Starter", "2 Hours", "€120"], ["legend", "Recording Legend", "6 Hours", "€280"], ["pro", "Recording Pro", "4 Hours", "€200"]]) {
      await page.click(`[data-package="${pkg}"]`);
      await idle(page);
      assert.equal(new URL(page.url()).searchParams.get("package"), pkg);
      assert.equal((await page.textContent("#package-name")).trim(), name);
      assert.equal((await page.textContent("#package-duration")).trim(), duration);
      assert.equal((await page.textContent("#package-price")).trim(), price);
      assert.equal((await page.textContent("#selected-date")).trim(), core.dateLabel(other), "date kept");
      const starts = await page.$$eval("#timeSlots .slot", (els) => els.map((e) => e.dataset.start));
      assert.deepEqual(starts, GRID[pkg], `${pkg} grid`);
      assert.equal(await page.isDisabled("#continueBtn"), true, "time must be chosen again");
    }
    await page.context().close();
  });

  await t.test("continue: one request even with a double click, hold created, Stripe opened", async () => {
    const page = await openPage({ pkg: "legend" });
    const { date, start } = await pickSlot(page);
    const posts = [];
    page.on("request", (r) => { if (r.url().endsWith("/api/create-checkout-session")) posts.push(r.postDataJSON()); });
    await page.dblclick("#continueBtn");
    await page.click("#continueBtn", { force: true, trial: false, timeout: 1000 }).catch(() => {});
    await page.waitForURL(/__stripe\//);
    assert.equal(posts.length, 1, "exactly one checkout request");
    assert.deepEqual(posts[0], { packageId: "legend", date, startTime: start }, "only package, date and time are sent");
    assert.equal((await page.textContent("#amount")).trim(), "28000", "price decided by the server");
    const rows = await bookingFor(date, start);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "pending_payment");
    assert.equal(rows[0].package_id, "legend");
    await page.context().close();
  });

  await t.test("cancel on Stripe: back on the checkout, hold released, slot free again", async () => {
    const page = await openPage();
    const { date, start } = await pickSlot(page);
    await page.click("#continueBtn");
    await page.waitForURL(/__stripe\//);
    assert.equal((await bookingFor(date, start))[0].status, "pending_payment");
    await page.click("#cancel");
    await page.waitForURL(/checkout\.html/);
    await idle(page);
    await page.waitForSelector("#bookingMessage:not([hidden])");
    assert.match(await page.textContent("#bookingMessage"), /Payment cancelled/);
    assert.equal(new URL(page.url()).searchParams.get("cancelled"), null, "URL cleaned");
    assert.equal(new URL(page.url()).searchParams.get("package"), "pro");
    assert.equal((await bookingFor(date, start))[0].status, "cancelled");
    assert.equal(await page.evaluate(() => sessionStorage.getItem("mrkll.bookingHold")), null);
    while (!(await page.$(`[data-date="${date}"]`))) { await page.click("#nextMonth"); await idle(page); }
    await page.click(`[data-date="${date}"]`);
    assert.equal(await page.isDisabled(`#timeSlots [data-start="${start}"]`), false, "slot available again");
    await page.context().close();
  });

  await t.test("browser back button from Stripe releases the hold", async () => {
    const page = await openPage({ pkg: "starter" });
    const { date, start } = await pickSlot(page);
    await page.click("#continueBtn");
    await page.waitForURL(/__stripe\//);
    await page.goBack();
    await page.waitForURL(/checkout\.html/);
    await idle(page);
    await page.waitForFunction(() => sessionStorage.getItem("mrkll.bookingHold") === null);
    for (let i = 0; i < 20 && (await bookingFor(date, start))[0].status !== "cancelled"; i++) await page.waitForTimeout(100);
    assert.equal((await bookingFor(date, start))[0].status, "cancelled");
    assert.equal((await page.textContent("#continueBtn")).trim(), "CONTINUE →", "button not stuck in loading state");
    await page.context().close();
  });

  await t.test("choosing again after a first checkout releases the previous hold", async () => {
    const page = await openPage();
    const first = await pickSlot(page);
    await page.click("#continueBtn");
    await page.waitForURL(/__stripe\//);
    await page.goto(`${server.base}/checkout.html?package=pro`); // new navigation, same tab
    await idle(page);
    const second = await pickSlot(page);
    await page.click("#continueBtn");
    await page.waitForURL(/__stripe\//);
    assert.equal((await bookingFor(first.date, first.start))[0].status, "cancelled");
    assert.equal((await bookingFor(second.date, second.start))[0].status, "pending_payment");
    await page.context().close();
  });

  await t.test("pay on Stripe: redirected to the confirmation page", async () => {
    const page = await openPage();
    await pickSlot(page);
    await page.click("#continueBtn");
    await page.waitForURL(/__stripe\//);
    await page.click("#pay");
    await page.waitForURL(/booking-success\.html\?session_id=cs_test_e2e_/);
    await page.context().close();
  });

  await t.test("slot taken by someone else meanwhile: clear message, calendar refreshed", async () => {
    const page = await openPage();
    const { date, start } = await pickSlot(page);
    await pool.query("select * from create_booking_hold('pro', $1::date, $2::time, 'e2e-other', repeat(md5('e2e-other'), 2))", [date, start]);
    await page.click("#continueBtn");
    await page.waitForSelector("#bookingMessage:not([hidden])");
    assert.match(await page.textContent("#bookingMessage"), /just been booked by someone else/);
    await idle(page);
    assert.equal(await page.isDisabled(`#timeSlots [data-start="${start}"]`), true, "slot now shown as booked");
    assert.match(await page.getAttribute(`#timeSlots [data-start="${start}"]`, "class"), /unavailable/);
    assert.equal(await page.isDisabled("#continueBtn"), true);
    assert.ok(page.url().includes("/checkout.html"), "no redirect");
    await page.context().close();
  });

  await t.test("network failure: message, button usable again, choice kept", async () => {
    const page = await openPage();
    const { date, start } = await pickSlot(page);
    await page.route("**/api/create-checkout-session", (r) => r.abort("internetdisconnected"));
    await page.click("#continueBtn");
    await page.waitForSelector("#bookingMessage:not([hidden])");
    assert.match(await page.textContent("#bookingMessage"), /Connection problem/);
    assert.equal(await page.isDisabled("#continueBtn"), false);
    assert.equal((await page.textContent("#session-time")).includes(start), true);
    assert.equal((await bookingFor(date, start)).length, 0, "nothing held");
    await page.context().close();
  });

  await t.test("availability service down: error shown, nothing selectable", async () => {
    const context = await newCustomer();
    const page = await context.newPage();
    await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    await page.route("**/api/availability**", (r) => r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "SERVICE_UNAVAILABLE", message: "x" } }) }));
    await page.goto(`${server.base}/checkout.html?package=pro`);
    await page.waitForSelector("#bookingMessage:not([hidden])");
    assert.match(await page.textContent("#bookingMessage"), /temporarily unavailable/);
    assert.equal(await page.$$eval("#calendarDays [data-date]", (e) => e.length), 0);
    assert.equal(await page.isDisabled("#continueBtn"), true);
    await context.close();
  });

  await t.test("a tampered request cannot change the price", async () => {
    const page = await openPage();
    const { date, start } = await pickSlot(page, undefined);
    const result = await page.evaluate(async ({ date, start }) => {
      const r = await fetch("/api/create-checkout-session", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packageId: "pro", date, startTime: start, price: 1, priceCents: 1, amount: 1, durationMinutes: 600 }),
      });
      return r.json();
    }, { date, start });
    assert.ok(result.url);
    const params = server.log.create[server.log.create.length - 1];
    assert.equal(params.line_items[0].price_data.unit_amount, 20000);
    const b = (await bookingFor(date, start))[0];
    assert.equal(b.price_cents, 20000);
    assert.equal((new Date(b.ends_at) - new Date(b.starts_at)) / 60000, 240);
    await page.context().close();
  });

  await t.test("anti-abuse: a 4th simultaneous hold from the same customer is refused with a clear message", async () => {
    const context = await newCustomer({ viewport: { width: 1280, height: 900 } });
    for (let i = 0; i < 4; i++) {
      const page = await context.newPage();
      await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
      await page.goto(`${server.base}/checkout.html?package=starter`);
      await page.evaluate(() => sessionStorage.clear()); // separate tabs keep their own holds
      await idle(page);
      await pickSlot(page);
      await page.click("#continueBtn");
      if (i < 3) {
        await page.waitForURL(/__stripe\//);
      } else {
        await page.waitForSelector("#bookingMessage:not([hidden])");
        assert.match(await page.textContent("#bookingMessage"), /already have a booking in progress/);
        assert.equal(await page.isDisabled("#continueBtn"), false);
      }
    }
    await context.close();
  });

  await t.test("mobile (390×844): single column, no horizontal overflow, usable tap targets", async () => {
    const page = await openPage({ width: 390, height: 844 });
    const m = await page.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      const cell = document.querySelector("#calendarDays [data-date]").getBoundingClientRect();
      return {
        vw: window.innerWidth,
        grid: r(".checkout-grid").right,
        panel: r(".calendar-panel").right,
        summary: r(".summary-card"),
        calendarBottom: r(".calendar-panel").bottom,
        cell: { w: cell.width, h: cell.height },
      };
    });
    assert.ok(m.grid <= m.vw && m.panel <= m.vw && m.summary.right <= m.vw, JSON.stringify(m));
    assert.ok(m.summary.top >= m.calendarBottom - 1, "summary below the calendar");
    assert.ok(m.cell.w >= 36 && m.cell.h >= 36, `day cells ${m.cell.w}x${m.cell.h}`);
    await pickSlot(page);
    await page.click("#continueBtn");
    await page.waitForURL(/__stripe\//);
    await page.context().close();
  });

  await t.test("other pages are unaffected: no JavaScript errors, mobile menu still works", async () => {
    const pages = ["index.html", "records.html", "studios.html", "recording.html", "mixing.html", "mastering.html",
      "live.html", "clothing.html", "contact.html", "booking.html", "booking-success.html"];
    const context = await newCustomer({ viewport: { width: 390, height: 844 } });
    for (const name of pages) {
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route(/fonts\.(googleapis|gstatic)\.com|unpkg\.com/, (r) => r.abort());
      await page.goto(`${server.base}/${name}`);
      const calls = [];
      page.on("request", (r) => { if (r.url().includes("/api/")) calls.push(r.url()); });
      if (await page.$("#hamburger")) {
        // Triggers main.js's click handler (visibility is a CSS matter, unchanged).
        await page.evaluate(() => document.getElementById("hamburger").click());
        assert.equal(await page.evaluate(() => document.getElementById("mobileMenu").classList.contains("active")), true, `${name}: menu opens`);
      }
      await page.waitForTimeout(150);
      assert.deepEqual(errors.filter((e) => !/lucide|WaveSurfer/.test(e)), [], `${name}: no errors`);
      assert.deepEqual(calls, [], `${name}: no booking API calls outside the checkout`);
      await page.close();
    }
    await context.close();
  });

  await t.test("tablet and desktop widths: two columns from 901px", async () => {
    for (const width of [768, 1024, 1440]) {
      const page = await openPage({ width, height: 900 });
      const m = await page.evaluate(() => ({
        vw: window.innerWidth,
        cal: document.querySelector(".calendar-panel").getBoundingClientRect(),
        sum: document.querySelector(".summary-card").getBoundingClientRect(),
      }));
      assert.ok(m.sum.right <= m.vw + 0.5 && m.cal.right <= m.vw + 0.5, `${width}: fits`);
      if (width > 900) assert.ok(m.sum.left > m.cal.left, `${width}: side by side`);
      else assert.ok(m.sum.top >= m.cal.bottom - 1, `${width}: stacked`);
      await page.context().close();
    }
  });
});
