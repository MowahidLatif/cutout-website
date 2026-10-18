const express = require("express");
const ordersService = require("../services/orders");
const { createCheckoutSession } = require("../services/stripe");
const { createPresignedUploadUrl } = require("../services/uploads");
const { ok, fail } = require("./_respond");

const router = express.Router();

router.post("/orders", async (req, res) => {
  try {
    const order = await ordersService.createOrder(req.body);
    ok(res, order, 201);
  } catch (err) {
    fail(res, err);
  }
});

router.get("/orders/:id", async (req, res) => {
  try {
    const order = await ordersService.getOrderById(req.params.id, {
      email: req.query.email,
    });
    ok(res, order);
  } catch (err) {
    fail(res, err);
  }
});

router.post("/orders/:id/checkout-session", async (req, res) => {
  try {
    const order = await ordersService.getOrderById(req.params.id);
    const session = await createCheckoutSession(order);
    await ordersService.setStripeSession(order.id, session.id);
    ok(res, { url: session.url });
  } catch (err) {
    fail(res, err);
  }
});

router.post("/uploads/presigned-url", async (req, res) => {
  try {
    const { fileName, contentType } = req.body;
    if (!fileName || !contentType) {
      return fail(
        res,
        Object.assign(new Error("fileName and contentType are required."), {
          code: "VALIDATION_ERROR",
        })
      );
    }
    const result = await createPresignedUploadUrl({ fileName, contentType });
    ok(res, result);
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;
