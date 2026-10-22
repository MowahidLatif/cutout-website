/**
 * Shared pricing formula — vanilla JS, no dependencies.
 *
 * This MUST produce the same result as backend/src/services/pricing.js.
 * It exists purely so the studio can show a live price as the customer
 * configures their order. The number it shows is never what's actually
 * charged — the backend recomputes from scratch before creating the
 * Stripe Checkout session. See docs/backend-guide.md.
 *
 * Loaded as a plain <script> tag — attaches to `window.Pricing`.
 */
(function () {
  /**
   * @param {Object} params
   * @param {string} params.sizeTier
   * @param {string} params.material
   * @param {number} params.quantity
   * @param {Array<{sizeTier:string, material:string, baseRate:number}>} params.rates
   * @param {Array<{minQty:number, maxQty:number|null, discountPct:number}>} params.discountTiers
   * @returns {{ baseRate: number, unitPrice: number, discountPct: number, subtotal: number, discountAmount: number, total: number } | null}
   */
  function calculatePrice({ sizeTier, material, quantity, rates, discountTiers }) {
    if (!sizeTier || !material || !quantity || quantity < 1) {
      return null;
    }

    const rateRow = (rates || []).find(
      (r) => r.sizeTier === sizeTier && r.material === material
    );
    if (!rateRow) {
      return null;
    }
    const baseRate = Number(rateRow.baseRate);

    const tier = (discountTiers || []).find(
      (t) => quantity >= t.minQty && (t.maxQty === null || quantity <= t.maxQty)
    );
    const discountPct = tier ? Number(tier.discountPct) : 0;

    const unitPrice = round2(baseRate * (1 - discountPct / 100));
    const subtotal = round2(baseRate * quantity);
    const total = round2(unitPrice * quantity);
    const discountAmount = round2(subtotal - total);

    return { baseRate, unitPrice, discountPct, subtotal, discountAmount, total };
  }

  /**
   * Shipping for a whole order: the first-unit rate is charged once, for the
   * "lead" item (the size with the highest first-unit rate); every other
   * cutout ships at its own size's additional rate. Mirrors shippingForItems /
   * calculateOrderShipping in the backend — keep them identical.
   *
   * @param {Object} params
   * @param {string} params.country
   * @param {Array<{sizeTier:string, quantity:number}>} params.items
   * @param {Array<{country:string, sizeTier:string, firstUnitRate:number, additionalUnitRate:number}>} params.shippingRates
   * @returns {number | null} null if the country isn't chosen or a size has no rate
   */
  function calculateOrderShipping({ country, items, shippingRates }) {
    if (!country || !items || !items.length) return null;
    const ratesByTier = {};
    (shippingRates || [])
      .filter((r) => r.country === country)
      .forEach((r) => {
        ratesByTier[r.sizeTier] = {
          firstUnitRate: Number(r.firstUnitRate),
          additionalUnitRate: Number(r.additionalUnitRate),
        };
      });

    let lead = null;
    let additionalTotal = 0;
    for (const item of items) {
      const rate = ratesByTier[item.sizeTier];
      if (!rate || !item.quantity || item.quantity < 1) return null;
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
    // The lead's first cutout pays the full rate instead of the additional one.
    return round2(additionalTotal + lead.firstUnitRate - lead.additionalUnitRate);
  }

  /**
   * The size tier follows from the height. Identical copy in
   * backend/src/services/pricing.js — the backend applies its own copy and
   * ignores any tier the browser sends.
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

  /**
   * Print quality as a 0–100 score: min(100, pixels-per-inch × 2), capped at
   * 59 when the photo is under 1000 px on its long side. Grades: great ≥ 90 ·
   * good ≥ 60 · fair ≥ 36 · low below. Also capped at 59 when the upload audit
   * says the photo looks blurry or heavily compressed (`issue`); a vector graphic
   * is always 100. Identical copy in backend/src/services/pricing.js, which
   * re-checks it (from the stored file) when the order is placed.
   *
   * @param {{ widthPx:number, heightPx:number, heightIn:number, widthIn?:number|null,
   *   blurry?:boolean, compressed?:boolean, vector?:boolean }} params
   * @returns {{ ppi: number|null, score: number, grade: "great"|"good"|"fair"|"low", issue: "blurry"|"compressed"|null, vector?: true }}
   */
  function printQuality({ widthPx, heightPx, heightIn, widthIn, blurry = false, compressed = false, vector = false }) {
    if (vector) return { ppi: null, score: 100, grade: "great", issue: null, vector: true };
    const printedWidth = widthIn || (heightIn * widthPx) / heightPx;
    const ppi = Math.round(Math.min(widthPx / printedWidth, heightPx / heightIn));
    let score = Math.min(100, ppi * 2);
    if (Math.max(widthPx, heightPx) < 1000) score = Math.min(score, 59);
    const issue = blurry ? "blurry" : compressed ? "compressed" : null;
    if (issue) score = Math.min(score, 59);
    const grade = score >= 90 ? "great" : score >= 60 ? "good" : score >= 36 ? "fair" : "low";
    return { ppi, score, grade, issue };
  }

  function round2(n) {
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }

  window.Pricing = { calculatePrice, calculateOrderShipping, sizeTierForHeight, printQuality };
})();
