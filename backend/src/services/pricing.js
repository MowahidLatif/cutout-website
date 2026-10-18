/**
 * Authoritative pricing logic. Must stay in sync with
 * frontend/js/pricing.js — see docs/backend-guide.md.
 */
const pool = require("../db/pool");

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

async function getPricingConfig() {
  const [ratesResult, tiersResult] = await Promise.all([
    pool.query(
      "SELECT size_tier, material, base_rate FROM pricing_config ORDER BY size_tier, material"
    ),
    pool.query(
      "SELECT min_qty, max_qty, discount_pct FROM quantity_discount_tiers ORDER BY min_qty"
    ),
  ]);

  return {
    rates: ratesResult.rows.map((r) => ({
      sizeTier: r.size_tier,
      material: r.material,
      baseRate: Number(r.base_rate),
    })),
    discountTiers: tiersResult.rows.map((t) => ({
      minQty: t.min_qty,
      maxQty: t.max_qty,
      discountPct: Number(t.discount_pct),
    })),
  };
}

/**
 * @param {Object} params
 * @param {string} params.sizeTier
 * @param {string} params.material
 * @param {number} params.quantity
 * @returns {Promise<{ baseRate: number, unitPrice: number, discountPct: number, subtotal: number, discountAmount: number, total: number }>}
 */
async function calculatePrice({ sizeTier, material, quantity }) {
  if (!quantity || quantity < 1) {
    throw Object.assign(new Error("Quantity must be at least 1."), {
      code: "VALIDATION_ERROR",
    });
  }

  const rateResult = await pool.query(
    "SELECT base_rate FROM pricing_config WHERE size_tier = $1 AND material = $2",
    [sizeTier, material]
  );
  if (rateResult.rowCount === 0) {
    throw Object.assign(
      new Error(`No pricing configured for size "${sizeTier}" and material "${material}".`),
      { code: "VALIDATION_ERROR" }
    );
  }
  const baseRate = Number(rateResult.rows[0].base_rate);

  const tierResult = await pool.query(
    `SELECT discount_pct FROM quantity_discount_tiers
     WHERE min_qty <= $1 AND (max_qty IS NULL OR max_qty >= $1)
     ORDER BY min_qty DESC LIMIT 1`,
    [quantity]
  );
  const discountPct = tierResult.rowCount > 0 ? Number(tierResult.rows[0].discount_pct) : 0;

  const unitPrice = round2(baseRate * (1 - discountPct / 100));
  const subtotal = round2(baseRate * quantity);
  const total = round2(unitPrice * quantity);
  const discountAmount = round2(subtotal - total);

  return { baseRate, unitPrice, discountPct, subtotal, discountAmount, total };
}

module.exports = { getPricingConfig, calculatePrice };
