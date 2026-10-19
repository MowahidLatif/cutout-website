/**
 * Authoritative pricing logic. Must stay in sync with
 * frontend/js/pricing.js — see docs/backend-guide.md.
 */
const pool = require("../db/pool");

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Print quality: how many of the photo's pixels land on each printed inch.
 * Standees are seen from a few feet away, so these are lower than paper
 * print standards. Identical copy in frontend/js/pricing.js.
 *
 *   great ≥ 50 ppi · good ≥ 30 · fair ≥ 18 · low below that
 *
 * @param {Object} params
 * @param {number} params.widthPx  stored image width in pixels
 * @param {number} params.heightPx stored image height in pixels
 * @param {number} params.heightIn printed height in inches
 * @param {number|null} [params.widthIn] printed width; defaults to the photo's proportions
 * @returns {{ ppi: number, grade: "great"|"good"|"fair"|"low" }}
 */
function printQuality({ widthPx, heightPx, heightIn, widthIn }) {
  const printedWidth = widthIn || (heightIn * widthPx) / heightPx;
  const ppi = Math.round(Math.min(widthPx / printedWidth, heightPx / heightIn));
  return { ppi, grade: qualityGrade(ppi) };
}

/** @returns {"great"|"good"|"fair"|"low"} */
function qualityGrade(ppi) {
  return ppi >= 50 ? "great" : ppi >= 30 ? "good" : ppi >= 18 ? "fair" : "low";
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
 * Shipping for a whole order: the first-unit rate is charged once per
 * order, for the "lead" item (the size with the highest first-unit rate),
 * and every other cutout ships at its own size's cheaper additional rate:
 *
 *   lead.first + lead.additional × (lead.qty − 1) + Σ others (additional × qty)
 *
 * A single-item order gives the same result as before. The quantity
 * discount never applies to shipping. Pure function — identical copy in
 * frontend/js/pricing.js.
 *
 * @param {Array<{ sizeTier: string, quantity: number }>} items
 * @param {Object<string, { firstUnitRate: number, additionalUnitRate: number }>} ratesByTier
 *   the destination country's rates, keyed by size tier
 * @returns {number|null} null if any item's size has no rate
 */
function shippingForItems(items, ratesByTier) {
  let lead = null;
  let additionalTotal = 0;
  for (const item of items) {
    const rate = ratesByTier[item.sizeTier];
    if (!rate) return null;
    additionalTotal += rate.additionalUnitRate * item.quantity;
    // Highest first-unit rate leads; ties go to the bigger first-unit premium.
    if (
      !lead ||
      rate.firstUnitRate > lead.firstUnitRate ||
      (rate.firstUnitRate === lead.firstUnitRate &&
        rate.firstUnitRate - rate.additionalUnitRate > lead.firstUnitRate - lead.additionalUnitRate)
    ) {
      lead = rate;
    }
  }
  if (!lead) return 0;
  // The lead's first cutout pays the full rate instead of the additional one.
  return round2(additionalTotal + lead.firstUnitRate - lead.additionalUnitRate);
}

/**
 * @param {Object} params
 * @param {string} params.country
 * @param {Array<{ sizeTier: string, quantity: number }>} params.items
 * @returns {Promise<number>}
 */
async function calculateOrderShipping({ country, items }) {
  const result = await pool.query(
    "SELECT size_tier, first_unit_rate, additional_unit_rate FROM shipping_rates WHERE country = $1",
    [country]
  );
  const ratesByTier = {};
  for (const r of result.rows) {
    ratesByTier[r.size_tier] = {
      firstUnitRate: Number(r.first_unit_rate),
      additionalUnitRate: Number(r.additional_unit_rate),
    };
  }
  const shipping = shippingForItems(items, ratesByTier);
  if (shipping === null) {
    const missing = items.find((i) => !ratesByTier[i.sizeTier]);
    throw Object.assign(
      new Error(`Shipping isn't available to "${country}" for size "${missing.sizeTier}".`),
      { code: "VALIDATION_ERROR" }
    );
  }
  return shipping;
}

module.exports = {
  CURRENCY,
  printQuality,
  qualityGrade,
  HEIGHT_RANGE_IN,
  sizeTierForHeight,
  getPricingConfig,
  calculatePrice,
  shippingForItems,
  calculateOrderShipping,
};
