const Stripe = require("stripe");

let stripeClient = null;
function getClient() {
  if (!stripeClient) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error("STRIPE_SECRET_KEY is not set.");
    }
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return stripeClient;
}

// Where Stripe sends the customer afterwards. The site is served by this
// backend, so by default both are pages on PUBLIC_API_URL (the site's address).
function siteUrl() {
  return (process.env.PUBLIC_API_URL || "http://localhost:4000").replace(/\/$/, "");
}

function successUrl() {
  return process.env.STRIPE_SUCCESS_URL || `${siteUrl()}/order-status?order={ORDER_ID}`;
}

function cancelUrl() {
  return process.env.STRIPE_CANCEL_URL || `${siteUrl()}/checkout`;
}

/**
 * Creates a Stripe Checkout Session for an order that's already been
 * priced server-side. Never pass a client-supplied amount here.
 */
async function createCheckoutSession(order) {
  const stripe = getClient();

  const session = await stripe.checkout.sessions.create({
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
            description: order.items
              .map((i) => `${i.quantity}x ${i.sizeTier} / ${i.material}`)
              .join(", "),
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
    success_url: successUrl().replace("{ORDER_ID}", order.id),
    cancel_url: cancelUrl(),
    metadata: { orderId: order.id },
  });

  return session;
}

function constructWebhookEvent(rawBody, signature) {
  const stripe = getClient();
  return stripe.webhooks.constructEvent(
    rawBody,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET
  );
}

module.exports = { createCheckoutSession, constructWebhookEvent };
