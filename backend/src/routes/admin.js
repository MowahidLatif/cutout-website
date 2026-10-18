/**
 * Internal/admin endpoints for the manual fulfillment workflow.
 * NOT auth-protected in v1 — see docs/api-spec.md. Don't expose this
 * publicly without adding at least a shared-secret or basic-auth check.
 */
const express = require("express");
const ordersService = require("../services/orders");
const { sendShippedNotification } = require("../services/email");
const { ok, fail } = require("./_respond");

const router = express.Router();

router.get("/admin/orders", async (req, res) => {
  try {
    const orders = await ordersService.listOrders({ status: req.query.status });
    ok(res, orders);
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
