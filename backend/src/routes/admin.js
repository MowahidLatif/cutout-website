/**
 * Internal/admin endpoints for the manual fulfillment workflow, used by
 * frontend/admin.html. Gated by a shared secret: every request needs an
 * `X-Admin-Token` header matching ADMIN_TOKEN. See docs/api-spec.md.
 */
const express = require("express");
const crypto = require("crypto");
const ordersService = require("../services/orders");
const { createDownloadUrl, isValidKey } = require("../services/storage");
const { sendShippedNotification } = require("../services/email");
const { ok, fail } = require("./_respond");

const DEV_ADMIN_TOKEN = "dev-admin-token";

const router = express.Router();

function requireAdmin(req, res, next) {
  const expected = Buffer.from(process.env.ADMIN_TOKEN || DEV_ADMIN_TOKEN);
  const given = Buffer.from(req.get("X-Admin-Token") || "");
  if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) {
    return next();
  }
  fail(res, Object.assign(new Error("Admin token missing or wrong."), { code: "UNAUTHORIZED" }));
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
    const order = await ordersService.getOrderById(req.params.id);
    const links = itemDownloadLinks(order);
    order.items = order.items.map((item, i) => ({
      ...item,
      downloadUrl: links[i].url,
      downloadExpiresAt: links[i].expiresAt,
    }));
    ok(res, order);
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
    const order = await ordersService.updateOrderStatus(req.params.id, status);
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
