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
        const order = await ordersService.markOrderPaid(orderId, session.payment_intent);
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
