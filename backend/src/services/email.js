/**
 * Thin SES wrapper. If AWS/SES isn't configured (e.g. local dev), these
 * functions log what would have been sent instead of throwing, so the
 * rest of the order flow keeps working without AWS credentials on hand.
 */
const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");
const { createDownloadUrl, isValidKey } = require("./storage");

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

/**
 * @param {Object} order
 * @param {Object} [options]
 * @param {boolean} [options.downloadLinks] include expiring image download
 *   links — only for the supplier-bound fulfillment email
 */
function formatOrderDetails(order, { downloadLinks = false } = {}) {
  const itemLines = order.items
    .map((i) => {
      let line = `  - ${i.quantity}x ${i.sizeTier} / ${i.material}, height ${i.heightIn}in`;
      if (i.widthIn) line += `, width ${i.widthIn}in`;
      for (const el of i.textElements || []) {
        line += `\n    text (${el.style}): "${el.text}"`;
      }
      if (downloadLinks && isValidKey(i.imageKey)) {
        const { url, expiresAt } = createDownloadUrl(i.imageKey);
        line += `\n    image download (expires ${expiresAt.slice(0, 10)}): ${url}`;
      }
      return line;
    })
    .join("\n");

  const addr = order.shippingAddress;
  return (
    `Order ID: ${order.id}\n` +
    `Customer: ${order.customerEmail} / ${order.customerPhone}\n` +
    `Shipping to: ${addr.line1}${addr.line2 ? ", " + addr.line2 : ""}, ${addr.city}, ${addr.region} ${addr.postalCode}, ${addr.country}\n` +
    `Shipping: $${order.shippingAmount.toFixed(2)} ${order.currency}\n` +
    `Total: $${order.totalPrice.toFixed(2)} ${order.currency}\n\n` +
    `Items (${order.items.reduce((n, i) => n + i.quantity, 0)} cutouts, ${order.items.length} design${order.items.length === 1 ? "" : "s"}):\n${itemLines}`
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
    body:
      formatOrderDetails(order, { downloadLinks: true }) +
      `\n\nLink expired? Open the order in admin.html and click "Generate fresh links".`,
  });
}

async function sendCustomerConfirmation(order) {
  await sendEmail({
    to: order.customerEmail,
    subject: "We've got your cutout order!",
    body:
      `Thanks for your order! Here's a summary:\n\n${formatOrderDetails(order)}\n\n` +
      `Your standee is made just for you, so all sales are final: we can't accept returns or ` +
      `give refunds. If it arrives damaged or misprinted, reply to this email with a photo ` +
      `within 7 days of delivery and we'll reprint it free.\n\n` +
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
