/**
 * Authoritative pricing logic. Must stay in sync with
 * frontend/js/pricing.js — see docs/backend-guide.md.
 */
const pool = require("../db/pool");

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Every price in the database, and every Stripe charge, is in this currency. */
const CURRENCY = "CAD";

/** Orderable standee heights, in inches (1–8 ft). */
const HEIGHT_RANGE_IN = { min: 12, max: 96 };

/**
 * The size tier follows from the height — the customer picks a height, not
 * a tier. Boundaries match the tier labels (small up to 3 ft, medium 3–5 ft,
 * life-size 5–6.5 ft, XL above). Identical copy in frontend/js/pricing.js.
 *
 * @param {number} heightIn
 * @returns {"small"|"medium"|"life_size"|"xl"}
 */
function sizeTierForHeight(heightIn) {
  if (heightIn <= 36) return "small";
  if (heightIn <= 60) return "medium";
  if (heightIn <= 78) return "life_size";
  return "xl";
}

async function getPricingConfig() {
  const [ratesResult, tiersResult, shippingResult] = await Promise.all([
    pool.query(
      "SELECT size_tier, material, base_rate FROM pricing_config ORDER BY size_tier, material"
    ),
    pool.query(
      "SELECT min_qty, max_qty, discount_pct FROM quantity_discount_tiers ORDER BY min_qty"
    ),
    pool.query(
      `SELECT country, size_tier, first_unit_rate, additional_unit_rate
       FROM shipping_rates ORDER BY country, size_tier`
    ),
  ]);

  return {
    currency: CURRENCY,
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
    shippingRates: shippingResult.rows.map((s) => ({
      country: s.country,
      sizeTier: s.size_tier,
      firstUnitRate: Number(s.first_unit_rate),
      additionalUnitRate: Number(s.additional_unit_rate),
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

/**
 * Shipping for one line: first unit at the full rate, each additional unit
 * at the cheaper rate. The quantity discount never applies to shipping.
 *
 * @param {Object} params
 * @param {string} params.country
 * @param {string} params.sizeTier
 * @param {number} params.quantity
 * @returns {Promise<number>}
 */
async function calculateShipping({ country, sizeTier, quantity }) {
  if (!quantity || quantity < 1) {
    throw Object.assign(new Error("Quantity must be at least 1."), {
      code: "VALIDATION_ERROR",
    });
  }

  const result = await pool.query(
    `SELECT first_unit_rate, additional_unit_rate FROM shipping_rates
     WHERE country = $1 AND size_tier = $2`,
    [country, sizeTier]
  );
  if (result.rowCount === 0) {
    throw Object.assign(
      new Error(`Shipping isn't available to "${country}" for size "${sizeTier}".`),
      { code: "VALIDATION_ERROR" }
    );
  }
  const firstUnitRate = Number(result.rows[0].first_unit_rate);
  const additionalUnitRate = Number(result.rows[0].additional_unit_rate);

  return round2(firstUnitRate + additionalUnitRate * (quantity - 1));
}

module.exports = {
  CURRENCY,
  HEIGHT_RANGE_IN,
  sizeTierForHeight,
  getPricingConfig,
  calculatePrice,
  calculateShipping,
};
