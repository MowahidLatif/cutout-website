/**
 * Stripe webhook. Mounted in server.js with express.raw() (NOT
 * express.json()) so the raw body is available for signature
 * verification — see docs/backend-guide.md.
 */
const express = require("express");
const { constructWebhookEvent } = require("../services/stripe");
const ordersService = require("../services/orders");
const { sendFulfillmentEmail, sendCustomerConfirmation } = require("../services/email");

const router = express.Router();

router.post("/webhooks/stripe", async (req, res) => {
  const signature = req.headers["stripe-signature"];

  let event;
  try {
    event = constructWebhookEvent(req.body, signature);
  } catch (err) {
    console.error("Stripe webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const orderId = session.metadata && session.metadata.orderId;

    if (orderId) {
      try {
        // amount_total is in cents; record what Stripe actually charged.
        const amount = typeof session.amount_total === "number" ? session.amount_total / 100 : undefined;
        const currency = session.currency ? session.currency.toUpperCase() : undefined;
        const { order, changed } = await ordersService.markOrderPaid(orderId, session.payment_intent, {
          amount,
          currency,
          rawPayload: event,
        });
        if (!changed) {
          // A retry of an event we've already handled (or the order wasn't
          // pending): the payment is recorded and the emails went out — do nothing.
          return res.json({ received: true });
        }
        // Only comparable in the same currency. (With Stripe Adaptive Pricing
        // the session still reports amount_total in CAD.)
        if (amount !== undefined && currency === order.currency && Math.abs(amount - order.totalPrice) > 0.005) {
          console.warn(
            `[stripe] order ${orderId}: Stripe charged ${amount.toFixed(2)} ${currency} but order total is ${order.totalPrice.toFixed(2)} ${order.currency}`
          );
        }
        await Promise.all([sendFulfillmentEmail(order), sendCustomerConfirmation(order)]);
      } catch (err) {
        console.error(`Failed to process paid order ${orderId}:`, err);
        // Still 200 the webhook — Stripe will retry on non-2xx, and the
        // failure here is on our side, not something a retry alone fixes
        // without also fixing the code. Log loudly instead.
      }
    }
  }

  res.json({ received: true });
});

module.exports = router;
