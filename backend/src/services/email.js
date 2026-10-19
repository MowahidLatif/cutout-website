/**
 * Thin SES wrapper. If AWS/SES isn't configured (e.g. local dev), these
 * functions log what would have been sent instead of throwing, so the
 * rest of the order flow keeps working without AWS credentials on hand.
 */
const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");
const { createDownloadUrl, isValidKey } = require("./storage");
const { siteUrl } = require("./site");
const { qualityGrade } = require("./pricing");
const {
  MATERIAL_LABELS,
  TIER_LABELS,
  TEXT_STYLE_LABELS,
  QUALITY_LABELS,
  formatFeetInches,
  plural,
} = require("./catalog");

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

function money(amount, currency) {
  return `$${Number(amount).toFixed(2)} ${currency}`;
}

function statusLink(order) {
  return `${siteUrl()}/order-status?order=${encodeURIComponent(order.id)}`;
}

/** Everything about one item that the customer and the supplier need. */
function formatItem(item, index) {
  const size = item.widthIn
    ? `${formatFeetInches(item.heightIn)} tall × ${formatFeetInches(item.widthIn)} wide`
    : `${formatFeetInches(item.heightIn)} tall`;
  const lines = [
    `${index + 1}. ${plural(item.quantity, "cutout")} — ${MATERIAL_LABELS[item.material] || item.material}`,
    `   Size: ${TIER_LABELS[item.sizeTier] || item.sizeTier}, ${size}`,
  ];
  for (const el of item.textElements || []) {
    lines.push(`   ${TEXT_STYLE_LABELS[el.style] || el.style}: "${el.text}"`);
  }
  if (item.printPpi) {
    const grade = qualityGrade(item.printPpi);
    lines.push(
      `   Print quality: ${QUALITY_LABELS[grade]} (${item.printPpi} pixels per inch)` +
        (item.lowQualityAccepted ? " — customer accepted low quality" : "")
    );
  }
  if (isValidKey(item.imageKey)) {
    const { url, expiresAt } = createDownloadUrl(item.imageKey);
    lines.push(`   Image (link expires ${expiresAt.slice(0, 10)}): ${url}`);
  }
  return lines.join("\n");
}

function formatOrderDetails(order) {
  const cutouts = order.items.reduce((n, i) => n + i.quantity, 0);
  const addr = order.shippingAddress;
  return [
    `Order ID: ${order.id}`,
    `Customer: ${order.customerEmail} / ${order.customerPhone}`,
    `Shipping to: ${addr.line1}${addr.line2 ? ", " + addr.line2 : ""}, ${addr.city}, ${addr.region} ${addr.postalCode}, ${addr.country}`,
    "",
    `Items (${plural(cutouts, "cutout")}, ${plural(order.items.length, "design")}):`,
    order.items.map(formatItem).join("\n\n"),
    "",
    `Shipping: ${money(order.shippingAmount, order.currency)}`,
    `Total: ${money(order.totalPrice, order.currency)}`,
  ].join("\n");
}

const FINAL_SALE_NOTICE =
  "Your standee is made just for you, so all sales are final: we can't accept returns or give refunds. " +
  "If it arrives damaged or misprinted, reply to this email with a photo within 7 days of delivery " +
  "and we'll reprint it free.";

function buildFulfillmentEmail(order) {
  return {
    to: process.env.FULFILLMENT_EMAIL,
    subject: `New paid order ${order.id} — forward to supplier`,
    body:
      formatOrderDetails(order) +
      `\n\nOrder status: ${statusLink(order)}` +
      `\nImage link expired? Open the order in the admin page (${siteUrl()}/admin) and click "Generate fresh links".`,
  };
}

function buildCustomerConfirmation(order) {
  return {
    to: order.customerEmail,
    subject: "We've got your cutout order!",
    body:
      `Thanks for your order! Here's a summary:\n\n${formatOrderDetails(order)}\n\n` +
      `${FINAL_SALE_NOTICE}\n\n` +
      `Check your order status any time: ${statusLink(order)}\n` +
      "(You'll need the email address you ordered with.)",
  };
}

function buildShippedNotification(order) {
  return {
    to: order.customerEmail,
    subject: "Your cutout has shipped!",
    body: `Good news — order ${order.id} is on its way.\n\nTrack its status: ${statusLink(order)}`,
  };
}

async function sendFulfillmentEmail(order) {
  if (!process.env.FULFILLMENT_EMAIL) {
    // Only possible outside production: production refuses to start without it.
    console.warn("FULFILLMENT_EMAIL is not set — skipping fulfillment email.");
    return;
  }
  await sendEmail(buildFulfillmentEmail(order));
}

async function sendCustomerConfirmation(order) {
  await sendEmail(buildCustomerConfirmation(order));
}

async function sendShippedNotification(order) {
  await sendEmail(buildShippedNotification(order));
}

module.exports = {
  buildFulfillmentEmail,
  buildCustomerConfirmation,
  buildShippedNotification,
  sendFulfillmentEmail,
  sendCustomerConfirmation,
  sendShippedNotification,
};
