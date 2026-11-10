"use strict";

// Local server for browser tests: the site's static files + the real API
// handlers (real SQL through the given repository) + a fake Stripe
// Checkout page. Never contacts Stripe, Supabase or Brevo.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createAvailabilityHandler } = require("../../api/availability");
const { createCheckoutHandler } = require("../../api/create-checkout-session");
const { createReleaseHoldHandler } = require("../../api/release-hold");

const ROOT = path.resolve(__dirname, "../..");
const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
  ".png": "image/png", ".jpg": "image/jpeg", ".JPG": "image/jpeg", ".jpG": "image/jpeg",
  ".svg": "image/svg+xml", ".mp3": "audio/mpeg",
};

function startTestServer({ repository }) {
  const sessions = new Map();
  const log = { create: [], release: [], availability: 0 };
  let base = "";

  const fakeStripe = {
    checkout: {
      sessions: {
        async create(params) {
          const id = `cs_test_e2e_${crypto.randomBytes(6).toString("hex")}`;
          const session = { id, status: "open", url: `${base}/__stripe/${id}`, params };
          sessions.set(id, session);
          log.create.push(params);
          return session;
        },
        async expire(id) {
          const s = sessions.get(id);
          if (!s || s.status !== "open") throw new Error("not expirable");
          s.status = "expired";
          return s;
        },
        async retrieve(id) {
          return sessions.get(id) || { id, status: "expired" };
        },
      },
    },
  };

  const site = () => ({ siteUrl: base, allowedOrigins: new Set([base]) });
  const availability = createAvailabilityHandler({ getRepository: () => repository });
  const checkout = createCheckoutHandler({
    getRepository: () => repository, getStripe: () => fakeStripe, getSite: site, getSalt: () => "e2e-salt-".repeat(5),
  });
  const release = createReleaseHoldHandler({ getRepository: () => repository, getStripe: () => fakeStripe, getSite: site });
  const routes = { "/api/availability": availability, "/api/create-checkout-session": checkout, "/api/release-hold": release };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const handler = routes[url.pathname];
    if (handler) {
      if (url.pathname === "/api/availability") log.availability += 1;
      if (url.pathname === "/api/release-hold") log.release.push(Date.now());
      try {
        await handler(req, res);
      } catch (error) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: { code: "TEST_SERVER", message: String(error) } }));
      }
      return;
    }

    // Fake Stripe Checkout page: "Pay" and "Cancel" behave like Stripe's redirects.
    const m = /^\/__stripe\/([\w]+)$/.exec(url.pathname);
    if (m) {
      const s = sessions.get(m[1]);
      if (!s) { res.statusCode = 404; res.end("unknown session"); return; }
      const success = s.params.success_url.replace("{CHECKOUT_SESSION_ID}", s.id);
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(`<!doctype html><title>Fake Stripe</title><h1 id="amount">${s.params.line_items[0].price_data.unit_amount}</h1>
        <p id="desc">${s.params.line_items[0].price_data.product_data.description}</p>
        <a id="pay" href="${success}">Pay</a> <a id="cancel" href="${s.params.cancel_url}">Cancel</a>`);
      return;
    }

    // Static files
    let file = decodeURIComponent(url.pathname);
    if (file === "/") file = "/index.html";
    const full = path.join(ROOT, file);
    if (!full.startsWith(ROOT) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.setHeader("content-type", TYPES[path.extname(full)] || "application/octet-stream");
    fs.createReadStream(full).pipe(res);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve({ base, server, sessions, log, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

module.exports = { startTestServer };
