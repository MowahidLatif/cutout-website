/**
 * Internal/admin endpoints for the manual fulfillment workflow, used by
 * frontend/admin.html. Gated by one shared secret (a single operator, no
 * accounts): every request needs an `X-Admin-Token` header matching
 * ADMIN_TOKEN. Failed attempts are rate-limited per IP, and in production
 * the token is only accepted over HTTPS. See docs/api-spec.md.
 */
const express = require("express");
const crypto = require("crypto");
const ordersService = require("../services/orders");
const { createDownloadUrl, isValidKey } = require("../services/storage");
const { sendShippedNotification } = require("../services/email");
const { ok, fail } = require("./_respond");

const DEV_ADMIN_TOKEN = "dev-admin-token";

const router = express.Router();

// ---------- Failed-attempt rate limit ----------
// In memory: fine for one server process; a restart resets the counters.
const MAX_FAILED_ATTEMPTS = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const failuresByIp = new Map(); // ip -> { count, windowStart }

function currentFailures(ip, now) {
  for (const [key, entry] of failuresByIp) {
    if (now - entry.windowStart >= FAILURE_WINDOW_MS) failuresByIp.delete(key);
  }
  return failuresByIp.get(ip);
}

function recordFailure(ip, now) {
  const entry = failuresByIp.get(ip) || { count: 0, windowStart: now };
  entry.count += 1;
  failuresByIp.set(ip, entry);
  return entry.count;
}

function adminError(message, code) {
  return Object.assign(new Error(message), { code });
}

/** Hashing both sides first makes the comparison constant-time regardless of length. */
function tokenMatches(given) {
  const expected = process.env.ADMIN_TOKEN || DEV_ADMIN_TOKEN;
  const digest = (value) => crypto.createHash("sha256").update(value).digest();
  return crypto.timingSafeEqual(digest(given), digest(expected));
}

function requireAdmin(req, res, next) {
  if (process.env.NODE_ENV === "production" && !req.secure) {
    return fail(res, adminError("Admin requires HTTPS.", "FORBIDDEN"));
  }
  if ("token" in req.query || "admin_token" in req.query || "adminToken" in req.query) {
    // Tokens in URLs end up in logs and browser history.
    return fail(
      res,
      adminError("Send the admin token in the X-Admin-Token header, never in the URL.", "VALIDATION_ERROR")
    );
  }

  const now = Date.now();
  const failures = currentFailures(req.ip, now);
  if (failures && failures.count >= MAX_FAILED_ATTEMPTS) {
    // Blocked even with the right token, so a lucky guess past the limit isn't confirmed.
    const retryAfterSec = Math.ceil((failures.windowStart + FAILURE_WINDOW_MS - now) / 1000);
    res.set("Retry-After", String(retryAfterSec));
    return fail(res, adminError("Too many failed attempts. Try again later.", "RATE_LIMITED"));
  }

  if (tokenMatches(req.get("X-Admin-Token") || "")) {
    return next();
  }

  const count = recordFailure(req.ip, now);
  console.warn(`[admin] failed auth from ${req.ip} (${count}/${MAX_FAILED_ATTEMPTS})`);
  fail(res, adminError("Admin token missing or wrong.", "UNAUTHORIZED"));
}

/** Who made an admin change: self-declared name (shared secret, so not proven) + IP + UA. */
function actorFrom(req) {
  const name = (req.get("X-Admin-Name") || "").trim().slice(0, 80) || "admin";
  return { name, ip: req.ip, userAgent: (req.get("User-Agent") || "").slice(0, 300) };
}

function itemDownloadLinks(order) {
  return order.items.map((item) => ({
    itemId: item.id,
    // Orders from before 003_image_key.sql hold a URL, not a key — no link for those.
    ...(isValidKey(item.imageKey) ? createDownloadUrl(item.imageKey) : { url: null, expiresAt: null }),
  }));
}

router.use("/admin", requireAdmin);

router.get("/admin/orders", async (req, res) => {
  try {
    const orders = await ordersService.listOrders({ status: req.query.status });
    ok(res, orders);
  } catch (err) {
    fail(res, err);
  }
});

router.get("/admin/orders/:id", async (req, res) => {
  try {
    const [order, statusEvents] = await Promise.all([
      ordersService.getOrderById(req.params.id),
      ordersService.getStatusEvents(req.params.id),
    ]);
    const links = itemDownloadLinks(order);
    order.items = order.items.map((item, i) => ({
      ...item,
      downloadUrl: links[i].url,
      downloadExpiresAt: links[i].expiresAt,
    }));
    ok(res, { ...order, statusEvents });
  } catch (err) {
    fail(res, err);
  }
});

router.post("/admin/orders/:id/download-links", async (req, res) => {
  try {
    const order = await ordersService.getOrderById(req.params.id);
    ok(res, itemDownloadLinks(order));
  } catch (err) {
    fail(res, err);
  }
});

router.patch("/admin/orders/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    const actor = actorFrom(req);
    const { order, fromStatus } = await ordersService.updateOrderStatus(req.params.id, status, actor);
    console.log(`[admin] ${actor.name}@${actor.ip} changed order ${order.id} ${fromStatus} → ${status}`);
    if (status === "shipped") {
      await sendShippedNotification(order);
    }
    ok(res, order);
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;
module.exports.DEV_ADMIN_TOKEN = DEV_ADMIN_TOKEN;
