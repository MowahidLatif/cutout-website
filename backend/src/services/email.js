/**
 * Thin SES wrapper. If AWS/SES isn't configured (e.g. local dev), these
 * functions log what would have been sent instead of throwing, so the
 * rest of the order flow keeps working without AWS credentials on hand.
 */
const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");

function sesConfigured() {
  return Boolean(
    process.env.AWS_ACCESS_KEY_ID &&
      process.env.AWS_SECRET_ACCESS_KEY &&
      process.env.SES_FROM_EMAIL
  );
}

let sesClient = null;
function getClient() {
  if (!sesClient) {
    sesClient = new SESClient({ region: process.env.AWS_REGION || "us-east-1" });
  }
  return sesClient;
}

async function sendEmail({ to, subject, body }) {
  if (!sesConfigured()) {
    console.log(`[email:dev] To: ${to}\nSubject: ${subject}\n\n${body}\n`);
    return;
  }

  const client = getClient();
  await client.send(
    new SendEmailCommand({
      Source: process.env.SES_FROM_EMAIL,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject },
        Body: { Text: { Data: body } },
      },
    })
  );
}

function formatOrderDetails(order) {
  const itemLines = order.items
    .map(
      (i) =>
        `  - ${i.quantity}x ${i.sizeTier} / ${i.material}, height ${i.heightIn}in\n` +
        `    image: ${i.imageUrl}`
    )
    .join("\n");

  const addr = order.shippingAddress;
  return (
    `Order ID: ${order.id}\n` +
    `Customer: ${order.customerEmail} / ${order.customerPhone}\n` +
    `Shipping to: ${addr.line1}${addr.line2 ? ", " + addr.line2 : ""}, ${addr.city}, ${addr.region} ${addr.postalCode}, ${addr.country}\n` +
    `Total: $${order.totalPrice.toFixed(2)}\n\n` +
    `Items:\n${itemLines}`
  );
}

async function sendFulfillmentEmail(order) {
  const to = process.env.FULFILLMENT_EMAIL;
  if (!to) {
    console.warn("FULFILLMENT_EMAIL is not set — skipping fulfillment email.");
    return;
  }
  await sendEmail({
    to,
    subject: `New paid order ${order.id} — forward to supplier`,
    body: formatOrderDetails(order),
  });
}

async function sendCustomerConfirmation(order) {
  await sendEmail({
    to: order.customerEmail,
    subject: "We've got your cutout order!",
    body:
      `Thanks for your order! Here's a summary:\n\n${formatOrderDetails(order)}\n\n` +
      `You can check your order status any time at order-status.html using your order ID and email.`,
  });
}

async function sendShippedNotification(order) {
  await sendEmail({
    to: order.customerEmail,
    subject: "Your cutout has shipped!",
    body: `Good news — order ${order.id} is on its way.`,
  });
}

module.exports = { sendFulfillmentEmail, sendCustomerConfirmation, sendShippedNotification };
