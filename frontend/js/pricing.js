/**
 * Shared pricing formula — vanilla JS, no dependencies.
 *
 * This MUST produce the same result as backend/src/services/pricing.js.
 * It exists purely so create.html can show a live price as the customer
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
   * Shipping for one line: first unit at the full rate, each additional
   * unit at the cheaper rate. Mirrors calculateShipping in the backend.
   *
   * @param {Object} params
   * @param {string} params.country
   * @param {string} params.sizeTier
   * @param {number} params.quantity
   * @param {Array<{country:string, sizeTier:string, firstUnitRate:number, additionalUnitRate:number}>} params.shippingRates
   * @returns {number | null}
   */
  function calculateShipping({ country, sizeTier, quantity, shippingRates }) {
    if (!country || !sizeTier || !quantity || quantity < 1) {
      return null;
    }

    const rateRow = (shippingRates || []).find(
      (s) => s.country === country && s.sizeTier === sizeTier
    );
    if (!rateRow) {
      return null;
    }

    return round2(
      Number(rateRow.firstUnitRate) + Number(rateRow.additionalUnitRate) * (quantity - 1)
    );
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

  function round2(n) {
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }

  window.Pricing = { calculatePrice, calculateShipping, sizeTierForHeight };
})();
