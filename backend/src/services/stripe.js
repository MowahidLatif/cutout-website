const Stripe = require("stripe");
const config = require("../config");

let stripeClient = null;
function getClient() {
  if (!stripeClient) {
    if (!config.stripeSecretKey) {
      throw new Error("STRIPE_SECRET_KEY is not set.");
    }
    stripeClient = new Stripe(config.stripeSecretKey);
  }
  return stripeClient;
}

const { MATERIAL_LABELS, TIER_LABELS, formatFeetInches } = require("./catalog");

// Stripe's limit for a product description.
const MAX_DESCRIPTION_LENGTH = 500;

/** "7 × Life-size 5'8" × 4'3" — Premium Corrugated (corrugated plastic / Coroplast)" */
function describeItem(item) {
  const size = item.widthIn
    ? `${formatFeetInches(item.heightIn)} × ${formatFeetInches(item.widthIn)}`
    : `${formatFeetInches(item.heightIn)} tall`;
  const material = MATERIAL_LABELS[item.material] || item.material;
  return `${item.quantity} × ${TIER_LABELS[item.sizeTier] || item.sizeTier} ${size} — ${material}`;
}

/**
 * The Checkout Session parameters for an order that's already been priced
 * server-side. Pure (no Stripe calls), so it can be tested. Never pass a
 * client-supplied amount here.
 */
function buildSessionParams(order) {
  let description = order.items.map(describeItem).join("; ");
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    description = description.slice(0, MAX_DESCRIPTION_LENGTH - 1) + "…";
  }
  return {
    mode: "payment",
    customer_email: order.customerEmail,
    line_items: [
      {
        price_data: {
          // Always charged in CAD. Customers elsewhere can see their local
          // currency if Adaptive Pricing is on in the Stripe Dashboard; we
          // still settle in CAD.
          currency: order.currency.toLowerCase(),
          product_data: {
            name: "Custom life-size standee order",
            description,
          },
          // Stripe expects the smallest currency unit (cents).
          unit_amount: Math.round(order.totalPrice * 100),
        },
        quantity: 1,
      },
    ],
    // Shown next to Stripe's pay button, so the final-sale policy is in
    // front of the customer at the moment they pay.
    custom_text: {
      submit: {
        message:
          "All sales are final — each standee is custom-made for you. " +
          "Damaged or misprinted? We'll reprint it free (see our returns policy).",
      },
    },
    success_url: config.stripeSuccessUrl.replace("{ORDER_ID}", order.id),
    cancel_url: config.stripeCancelUrl,
    metadata: { orderId: order.id },
  };
}

async function createCheckoutSession(order) {
  return getClient().checkout.sessions.create(buildSessionParams(order));
}

function constructWebhookEvent(rawBody, signature) {
  const stripe = getClient();
  return stripe.webhooks.constructEvent(
    rawBody,
    signature,
    config.stripeWebhookSecret
  );
}

module.exports = { buildSessionParams, createCheckoutSession, constructWebhookEvent };
