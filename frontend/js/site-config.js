/**
 * Every hard-coded storefront value in one place, until real supplier and
 * business data is in. Attaches to `window.SITE`.
 *
 * PLACEHOLDER: the delivery times, the "from" price and the rating below
 * are copied from the design mockups, not measured. Replace them (and the
 * PLACEHOLDER-marked copy in index.html) before launch.
 *
 * Prices themselves are NOT here — they always come from
 * GET /api/pricing-config, and the backend recomputes them.
 */
(function () {
  window.SITE = {
    brand: "CutoutCraft",

    // Every price is in this currency (it also comes back from
    // GET /api/pricing-config as `currency`). Stripe charges CAD.
    currency: "CAD",

    // Final-sale (no returns) policy shown in policies.html and accepted at
    // checkout. Must match POLICY_VERSION in backend/src/services/orders.js.
    policyVersion: "2026-10-18",
    damageClaimDays: 7,

    // PLACEHOLDER — set once the domain is chosen.
    supportEmail: "support@example.com",

    // PLACEHOLDER — production + shipping times (business days).
    productionDays: 2,
    transitDaysMin: 3,
    transitDaysMax: 5,

    // PLACEHOLDER — marketing numbers shown in the hero.
    fromPrice: 29,
    rating: { score: "4.9", outOf: 5, shipped: "12,000+" },

    // Heights the studio allows (inches). Must match HEIGHT_RANGE_IN in
    // backend/src/services/pricing.js.
    heightMinIn: 12,
    heightMaxIn: 96,
    defaultHeightIn: 72,
    // Width limits when proportions are unlocked. Must match the backend.
    widthMinIn: 6,
    widthMaxIn: 96,

    // The scale preview's wall height and reference figures (inches).
    wallHeightIn: 108,
    references: {
      person: { label: "5'9\" adult", heightIn: 69 },
      door: { label: "6'8\" door", heightIn: 80 },
    },

    // Material catalogue. `id` is the backend material value.
    materials: [
      // Corrugated *plastic*. Backend label: MATERIAL_LABELS.coroplast in
      // backend/src/services/catalog.js (a test keeps the two in step).
      { id: "coroplast", name: "Premium Corrugated", detail: "Corrugated plastic (Coroplast) with fold-out easel" },
      { id: "foam_board", name: "Foam Board", detail: "Lightweight, ultra-smooth finish", comingSoon: true },
      { id: "acrylic", name: "Acrylic", detail: "Glossy, weatherproof, built to last", comingSoon: true },
    ],

    // Print quality grades (pixels per printed inch) — thresholds live in
    // js/pricing.js printQuality(), mirrored in the backend.
    qualityLabels: { great: "Great", good: "Good", fair: "Fair", low: "Low" },

    tierLabels: {
      small: "Small",
      medium: "Medium",
      life_size: "Life-size",
      xl: "XL",
    },

    // Text elements. Must match the backend's limits.
    textStyles: {
      bubble: "Speech bubble",
      placard: "Placard",
      caption: "Caption",
    },
    maxTextElements: 3,
    maxTextLength: 100, // keep in step with MAX_TEXT_LENGTH on the backend

    // Shipping estimate shown in the studio before the customer picks a country.
    defaultCountry: "CA",
    countryLabels: { CA: "Canada", US: "the United States" },

    // Keep in step with UPLOAD_MAX_MB on the backend: the most a file can be
    // and still be emailed to the printer.
    maxUploadMb: 18,

    // Per-order limits. Must match MAX_ORDER_QUANTITY / MAX_UNIQUE_IMAGES in
    // backend/src/services/orders.js.
    maxOrderQuantity: 500, // cutouts in total
    maxUniqueImages: 10, // different photos
  };
})();
