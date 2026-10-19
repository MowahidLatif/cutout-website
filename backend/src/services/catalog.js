/**
 * Customer-facing names for stored values, used in emails and on the Stripe
 * payment page so they read exactly like the storefront.
 *
 * The storefront's own copy lives in frontend/js/site-config.js
 * (SITE.materials / tierLabels / textStyles); test/material-integrity.test.js
 * fails if the two drift apart.
 */
const MATERIAL_LABELS = {
  // The studio's "Premium Corrugated" is corrugated *plastic* (Coroplast).
  coroplast: "Premium Corrugated (corrugated plastic / Coroplast)",
  cardboard: "Corrugated cardboard",
  foam_board: "Foam Board",
  acrylic: "Acrylic",
};

const TIER_LABELS = {
  small: "Small",
  medium: "Medium",
  life_size: "Life-size",
  xl: "XL",
};

const TEXT_STYLE_LABELS = {
  bubble: "Speech bubble",
  placard: "Placard",
  caption: "Caption",
};

const QUALITY_LABELS = {
  great: "Great",
  good: "Good",
  fair: "Fair",
  low: "Low",
};

function formatFeetInches(inches) {
  const total = Math.round(Number(inches));
  return `${Math.floor(total / 12)}'${total % 12}"`;
}

/** "1 cutout" / "3 cutouts". */
function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

module.exports = { MATERIAL_LABELS, TIER_LABELS, TEXT_STYLE_LABELS, QUALITY_LABELS, formatFeetInches, plural };
