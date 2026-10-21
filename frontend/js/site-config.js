/**
 * Every hard-coded storefront value in one place, until real supplier and
 * business data is in, plus the URLs the browser talks to. Attaches to
 * `window.SITE`. Loaded by every page, before the other scripts.
 *
 * Nothing here is secret: everything the browser loads is public. Secrets
 * (Stripe, AWS, admin token) live only in backend/.env.
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

    // Border printed around each cutout (per photo). Stored on the order as
    // the hex code. Same list as BORDER_COLORS in backend/src/services/catalog.js.
    // Free for now: choosing a border doesn't change the price.
    borderColors: [
      { name: "White", hex: "#FFFFFF" },
      { name: "Black", hex: "#000000" },
      { name: "Blue", hex: "#1E5AA8" },
      { name: "Green", hex: "#2E8B57" },
      { name: "Orange", hex: "#F28C28" },
      { name: "Red", hex: "#D62828" },
      { name: "Yellow", hex: "#F7C948" },
    ],
    defaultBorderColor: "#FFFFFF",
    maxNotesLength: 150, // per photo; same as the server's limit

    // ---------- Where the browser sends requests ----------
    // The backend serves the site and the API on the same origin, so this is
    // a relative path. Only if the frontend is ever hosted elsewhere: change
    // it to the API's full URL and set FRONTEND_ORIGIN on the backend (CORS).
    apiBaseUrl: "/api",

    // In-browser background remover (js/background-removal.js). Library and
    // model are pinned so they can't change under us; both Apache-2.0. The
    // hosts must also be allowed by the CSP in backend/src/security.js
    // (jsDelivr for the library, huggingface.co / *.hf.co for the model).
    backgroundRemoval: {
      libraryUrl: "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/dist/transformers.min.js",
      model: "Xenova/modnet",
      modelRevision: "fa2fa546052fba4c08921230a26cc69a333fca12",
    },
  };
})();
