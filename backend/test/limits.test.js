/** 5. Limits: rate limits (429 + Retry-After), body size (413), file type (415). */
const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { useTestDb, useTempUploads, startApp } = require("./helpers");

const TOKEN = "t".repeat(40);
let db, app;

test.before(async () => {
  process.env.ADMIN_TOKEN = TOKEN;
  db = await useTestDb();
  useTempUploads();
  app = await startApp();
});
test.after(async () => {
  await app.close();
  await db.close();
});

const json = (pathname, body) =>
  fetch(`${app.url}${pathname}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("an oversized JSON body is a 413", async () => {
  const res = await json("/api/orders", { padding: "x".repeat(150 * 1024) });
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error.code, "PAYLOAD_TOO_LARGE");
});

test("an unsupported file type is a 415", async () => {
  const gif = await sharp({ create: { width: 50, height: 50, channels: 3, background: "#123" } }).gif().toBuffer();
  const form = new FormData();
  form.append("image", new Blob([gif]), "photo.jpg"); // lying extension: we check the contents
  const res = await fetch(`${app.url}/api/uploads`, { method: "POST", body: form });
  assert.equal(res.status, 415);
  assert.equal((await res.json()).error.code, "UNSUPPORTED_MEDIA_TYPE");
});

test("creating orders is limited to 10 per 15 minutes per IP", async () => {
  for (let i = 0; i < 10; i++) assert.equal((await json("/api/orders", {})).status, 400);
  const res = await json("/api/orders", {});
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get("retry-after")) > 0, "Retry-After header");
  assert.equal((await res.json()).error.code, "RATE_LIMITED");
});

test("uploads are limited to 40 per 15 minutes per IP (a photo + its cutout is two)", async () => {
  const upload = () => fetch(`${app.url}/api/uploads`, { method: "POST", body: new FormData() });
  // The 415 test above already used one.
  for (let i = 0; i < 39; i++) assert.equal((await upload()).status, 400);
  const res = await upload();
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error.code, "RATE_LIMITED");
});

test("admin: successful requests don't count; 10 failed attempts lock the IP out", async () => {
  const get = (token) => fetch(`${app.url}/api/admin/orders`, { headers: { Authorization: `Bearer ${token}` } });
  for (let i = 0; i < 15; i++) assert.equal((await get(TOKEN)).status, 200);
  for (let i = 0; i < 10; i++) assert.equal((await get("wrong")).status, 401);
  const blocked = await get(TOKEN); // even the right token, so a lucky guess isn't confirmed
  assert.equal(blocked.status, 429);
  assert.ok(blocked.headers.get("retry-after"));
});

test("the Stripe webhook and /health are never rate limited", async () => {
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${app.url}/api/webhooks/stripe`, { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": "bad" }, body: "{}" });
    assert.equal(res.status, 400);
  }
  for (let i = 0; i < 40; i++) assert.equal((await fetch(`${app.url}/health`)).status, 200);
});

test("security headers are set and X-Powered-By is gone", async () => {
  const res = await fetch(`${app.url}/`);
  const csp = res.headers.get("content-security-policy");
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self' https:\/\/js\.stripe\.com/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(res.headers.get("x-powered-by"), null);
  assert.equal(res.headers.get("strict-transport-security"), null, "HSTS only in production");
});
