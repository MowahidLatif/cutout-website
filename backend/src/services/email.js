/**
 * Thin SES wrapper. If AWS/SES isn't configured (e.g. local dev), these
 * functions log what would have been sent instead of throwing, so the
 * rest of the order flow keeps working without AWS credentials on hand.
 */
const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");
const { createDownloadUrl, isValidKey } = require("./storage");
const config = require("../config");
const { qualityGrade } = require("./pricing");
const {
  MATERIAL_LABELS,
  TIER_LABELS,
  TEXT_STYLE_LABELS,
  QUALITY_LABELS,
  borderLabel,
  formatFeetInches,
  plural,
} = require("./catalog");

let sesClient = null;
function getClient() {
  if (!sesClient) {
    sesClient = new SESClient({ region: config.awsRegion });
  }
  return sesClient;
}

async function sendEmail({ to, subject, body }) {
  if (!config.sesConfigured) {
    console.log(`[email:dev] To: ${to}\nSubject: ${subject}\n\n${body}\n`);
    return;
  }

  const client = getClient();
  await client.send(
    new SendEmailCommand({
      Source: config.sesFromEmail,
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
  return `${config.siteUrl}/order-status?order=${encodeURIComponent(order.id)}`;
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
    // Older rows have no stored score; derive it from the ppi.
    const score = item.printScore ?? Math.min(100, item.printPpi * 2);
    lines.push(
      `   Print quality: ${QUALITY_LABELS[qualityGrade(score)]} — ${score}/100 (${item.printPpi} pixels per inch)` +
        (item.lowQualityAccepted ? " — customer accepted low quality" : "")
    );
  }
  lines.push(
    item.hasTransparency
      ? "   Background: removed — transparent PNG, cut along the outline"
      : "   Background: kept (print the whole photo)",
    `   ${borderLabel(item.borderColor)}`
  );
  if (item.notes) lines.push(`   Notes: ${item.notes}`);
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
    `Customer: ${order.customerName ? order.customerName + " — " : ""}${order.customerEmail} / ${order.customerPhone}`,
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
    to: config.fulfillmentEmail,
    subject: `New paid order ${order.id} — forward to supplier`,
    body:
      formatOrderDetails(order) +
      `\n\nOrder status: ${statusLink(order)}` +
      `\nImage link expired? Open the order in the admin page (${config.siteUrl}/admin) and click "Generate fresh links".`,
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
  const tracking = [
    order.carrier ? `Carrier: ${order.carrier}` : null,
    order.trackingNumber ? `Tracking number: ${order.trackingNumber}` : null,
    order.trackingUrl ? `Track your package: ${order.trackingUrl}` : null,
  ].filter(Boolean);
  return {
    to: order.customerEmail,
    subject: "Your cutout has shipped!",
    body:
      `Good news${order.customerName ? ", " + order.customerName : ""} — order ${order.id} is on its way.\n\n` +
      (tracking.length ? tracking.join("\n") + "\n\n" : "") +
      `Order status: ${statusLink(order)}`,
  };
}

async function sendFulfillmentEmail(order) {
  if (!config.fulfillmentEmail) {
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
