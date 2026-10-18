const express = require("express");
const multer = require("multer");
const ordersService = require("../services/orders");
const { createCheckoutSession } = require("../services/stripe");
const { processUpload, maxUploadBytes } = require("../services/uploads");
const { ok, fail } = require("./_respond");

const router = express.Router();

// Held in memory only long enough to validate it; storage.js decides where
// the cleaned-up image ends up.
const parseImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxUploadBytes(), files: 1 },
}).single("image");

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

router.post("/uploads", (req, res) => {
  parseImage(req, res, async (parseErr) => {
    try {
      const fieldHint = 'Attach one photo as a multipart field named "image".';
      if (parseErr) {
        const message =
          parseErr.code === "LIMIT_FILE_SIZE"
            ? `That file is too large. The maximum is ${process.env.UPLOAD_MAX_MB || 25} MB.`
            : parseErr.code === "LIMIT_UNEXPECTED_FILE" || parseErr.code === "LIMIT_FILE_COUNT"
              ? fieldHint
              : `Upload failed: ${parseErr.message}`;
        throw Object.assign(new Error(message), { code: "VALIDATION_ERROR" });
      }
      if (!req.file) {
        throw Object.assign(new Error(fieldHint), { code: "VALIDATION_ERROR" });
      }
      const result = await processUpload(req.file.buffer);
      ok(res, result, 201);
    } catch (err) {
      fail(res, err);
    }
  });
});

module.exports = router;
