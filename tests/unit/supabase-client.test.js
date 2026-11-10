"use strict";

// What the backend really sends to Supabase (HTTP intercepted, no network).

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSupabaseClient, createSupabaseRepository } = require("../../api/_lib/db");

const NEW_KEY = "sb_secret_FAKE_LOCAL_ONLY_0123456789abcdef";
const LEGACY_KEY = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.fake";

function capture(body = "[]") {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), method: init.method || "GET", headers: Object.fromEntries([...new Headers(init.headers)]) });
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  };
  return { requests, fetchImpl };
}

test("new secret key (sb_secret_): sent only in the apikey header", async () => {
  const { requests, fetchImpl } = capture();
  const repo = createSupabaseRepository(createSupabaseClient("https://ref.supabase.co", NEW_KEY, { fetchImpl }));
  await repo.getAvailability("pro", "2026-12-01", "2026-12-31");
  await repo.claimNotification("k-1", null, "x");
  for (const r of requests) {
    assert.equal(r.headers.apikey, NEW_KEY, r.url);
    assert.equal(r.headers.authorization, undefined, `${r.url}: no Authorization header`);
    assert.equal(r.headers["x-client-info"], "mrkll-api");
  }
  assert.equal(requests[0].url, "https://ref.supabase.co/rest/v1/rpc/get_availability");
  assert.equal(requests[0].method, "POST");
});

test("table reads use the same headers", async () => {
  const { requests, fetchImpl } = capture('{"timezone":"Europe/Madrid","max_advance_days":90}');
  const repo = createSupabaseRepository(createSupabaseClient("https://ref.supabase.co", NEW_KEY, { fetchImpl }));
  await repo.getSettings();
  assert.match(requests[0].url, /\/rest\/v1\/studio_settings\?select=/);
  assert.equal(requests[0].headers.apikey, NEW_KEY);
  assert.equal(requests[0].headers.authorization, undefined);
});

test("legacy service_role JWT keeps the Authorization header (backward compatible)", async () => {
  const { requests, fetchImpl } = capture();
  const repo = createSupabaseRepository(createSupabaseClient("https://ref.supabase.co", LEGACY_KEY, { fetchImpl }));
  await repo.getAvailability("pro", "2026-12-01", "2026-12-31");
  assert.equal(requests[0].headers.apikey, LEGACY_KEY);
  assert.equal(requests[0].headers.authorization, `Bearer ${LEGACY_KEY}`);
});
