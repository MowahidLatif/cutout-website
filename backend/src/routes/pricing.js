const express = require("express");
const { getPricingConfig } = require("../services/pricing");
const { ok, fail } = require("./_respond");

const router = express.Router();

router.get("/pricing-config", async (req, res) => {
  try {
    const config = await getPricingConfig();
    ok(res, config);
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;
