const pool = require("../db/pool");
const {
  calculatePrice,
  calculateOrderShipping,
  sizeTierForHeight,
  printQuality,
  HEIGHT_RANGE_IN,
  CURRENCY,
} = require("./pricing");
const storage = require("./storage");

const VALID_MATERIALS = ["cardboard", "coroplast", "foam_board", "acrylic"];
const VALID_COUNTRIES = ["CA", "US"];
const WIDTH_RANGE_IN = { min: 6, max: 96 };
const TEXT_STYLES = ["bubble", "placard", "caption"];
const MAX_TEXT_ELEMENTS = 3;
const MAX_TEXT_LENGTH = 100;
// Server-side field limits (characters). Same values as the checkout form.
const FIELD_LIMITS = {
  customerName: 100,
  customerEmail: 254,
  customerPhone: 30,
  line1: 200,
  line2: 200,
  city: 200,
  region: 200,
  postalCode: 20,
  notes: 2000,
};
const MAX_NOTE_LENGTH = 2000;
const MAX_TRACKING_LENGTH = 100;
const MAX_TRACKING_URL_LENGTH = 500;
// The only status changes an admin can make. Anything else is a 409.
// (pending_payment → paid is the Stripe webhook's job, never an admin's.)
const ALLOWED_TRANSITIONS = {
  paid: ["in_production", "cancelled"],
  in_production: ["shipped", "cancelled"],
  shipped: ["delivered"],
};
const ADMIN_PAGE_SIZE = 25;
// Per-order limits. Same values as SITE.maxOrderQuantity / SITE.maxUniqueImages
// in frontend/js/site-config.js.
const MAX_ORDER_QUANTITY = 500; // cutouts in total, across all items
const MAX_UNIQUE_IMAGES = 10; // different photos
// Version of the final-sale (no returns) policy the customer agrees to at
// checkout — bump it whenever frontend/policies.html changes materially.
// Same value as SITE.policyVersion in frontend/js/site-config.js.
const POLICY_VERSION = "2026-10-18";

function validationError(message) {
  return Object.assign(new Error(message), { code: "VALIDATION_ERROR" });
}

function notFoundError(message) {
  return Object.assign(new Error(message), { code: "NOT_FOUND" });
}

function conflictError(message) {
  return Object.assign(new Error(message), { code: "CONFLICT" });
}

/** Rejects strings over their limit (and non-strings) with a plain message. */
function checkLength(value, max, label) {
  if (value === undefined || value === null || value === "") return;
  if (typeof value !== "string") throw validationError(`${label} must be text.`);
  if (value.length > max) throw validationError(`${label} must be at most ${max} characters.`);
}

function validateOrderInput({ customerName, customerEmail, customerPhone, shippingAddress, items, acceptedFinalSale }) {
  if (acceptedFinalSale !== true) {
    throw validationError(
      "Please confirm you understand each standee is custom-made and final sale (no returns or refunds)."
    );
  }
  if (typeof customerName !== "string" || !customerName.trim()) {
    throw validationError("Your full name is required.");
  }
  checkLength(customerName.trim(), FIELD_LIMITS.customerName, "Name");
  checkLength(customerEmail, FIELD_LIMITS.customerEmail, "Email");
  if (!customerEmail || !/^\S+@\S+\.\S+$/.test(customerEmail)) {
    throw validationError("A valid customerEmail is required.");
  }
  if (!customerPhone) {
    throw validationError("customerPhone is required.");
  }
  checkLength(customerPhone, FIELD_LIMITS.customerPhone, "Phone");
  if (!shippingAddress || typeof shippingAddress !== "object" || !shippingAddress.line1 || !shippingAddress.city) {
    throw validationError("shippingAddress with at least line1 and city is required.");
  }
  checkLength(shippingAddress.line1, FIELD_LIMITS.line1, "Address line 1");
  checkLength(shippingAddress.line2, FIELD_LIMITS.line2, "Address line 2");
  checkLength(shippingAddress.city, FIELD_LIMITS.city, "City");
  checkLength(shippingAddress.region, FIELD_LIMITS.region, "Province / state");
  checkLength(shippingAddress.postalCode, FIELD_LIMITS.postalCode, "Postal / ZIP code");
  if (!VALID_COUNTRIES.includes(shippingAddress.country)) {
    throw validationError(
      `We currently only ship to ${VALID_COUNTRIES.join(" and ")} (got: ${shippingAddress.country}).`
    );
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw validationError("At least one order item is required.");
  }
  for (const item of items) {
    if (!VALID_MATERIALS.includes(item.material)) {
      throw validationError(`Invalid material: ${item.material}`);
    }
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_ORDER_QUANTITY) {
      throw validationError(`Each item needs a whole-number quantity from 1 to ${MAX_ORDER_QUANTITY}.`);
    }
    const heightIn = Number(item.heightIn);
    if (!(heightIn >= HEIGHT_RANGE_IN.min && heightIn <= HEIGHT_RANGE_IN.max)) {
      throw validationError(
        `Height must be between ${HEIGHT_RANGE_IN.min / 12} and ${HEIGHT_RANGE_IN.max / 12} ft.`
      );
    }
    if (item.widthIn !== undefined && item.widthIn !== null) {
      const widthIn = Number(item.widthIn);
      if (!(widthIn >= WIDTH_RANGE_IN.min && widthIn <= WIDTH_RANGE_IN.max)) {
        throw validationError(
          `Width must be between ${WIDTH_RANGE_IN.min} in and ${WIDTH_RANGE_IN.max / 12} ft.`
        );
      }
    }
    validateTextElements(item.textElements);
    checkLength(item.notes, FIELD_LIMITS.notes, "Item notes");
    if (!storage.isValidKey(item.imageKey)) {
      throw validationError("Each item needs an imageKey from POST /api/uploads.");
    }
  }

  const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
  if (totalQuantity > MAX_ORDER_QUANTITY) {
    throw validationError(
      `An order can have at most ${MAX_ORDER_QUANTITY} cutouts (this one has ${totalQuantity}).`
    );
  }
  const uniqueImages = new Set(items.map((item) => item.imageKey)).size;
  if (uniqueImages > MAX_UNIQUE_IMAGES) {
    throw validationError(
      `An order can have at most ${MAX_UNIQUE_IMAGES} different photos (this one has ${uniqueImages}).`
    );
  }
}

function validateTextElements(textElements) {
  if (textElements === undefined || textElements === null) return;
  if (!Array.isArray(textElements) || textElements.length > MAX_TEXT_ELEMENTS) {
    throw validationError(`Up to ${MAX_TEXT_ELEMENTS} text elements are allowed per standee.`);
  }
  for (const el of textElements) {
    if (!el || !TEXT_STYLES.includes(el.style)) {
      throw validationError(`Text style must be one of: ${TEXT_STYLES.join(", ")}.`);
    }
    const text = typeof el.text === "string" ? el.text.trim() : "";
    if (text.length < 1 || text.length > MAX_TEXT_LENGTH) {
      throw validationError(`Each text needs 1–${MAX_TEXT_LENGTH} characters.`);
    }
  }
}

async function createOrder(input) {
  validateOrderInput(input);
  const { customerEmail, customerPhone, shippingAddress, items } = input;
  const customerName = input.customerName.trim();

  // A well-formed key isn't enough — it must be a file we actually stored.
  // Its real pixel size (read from the file, never from the client) gives the
  // print quality; a "low" rating needs the customer's explicit OK.
  const imageSizes = [];
  for (const [index, item] of items.entries()) {
    if (!(await storage.fileExists(item.imageKey))) {
      throw validationError("Uploaded photo not found. Please upload it again.");
    }
    const size = await storage.readImageSize(item.imageKey);
    const quality = printQuality({
      widthPx: size.width,
      heightPx: size.height,
      heightIn: Number(item.heightIn),
      widthIn: item.widthIn ? Number(item.widthIn) : null,
    });
    if (quality.grade === "low" && item.acceptedLowQuality !== true) {
      throw validationError(
        `Photo ${index + 1} will print at low quality at this size (score ${quality.score}/100, ${quality.ppi} pixels per inch). ` +
          "Please confirm you accept that, use a sharper photo, or choose a smaller size."
      );
    }
    imageSizes.push({ ...size, ppi: quality.ppi, score: quality.score, lowAccepted: quality.grade === "low" });
  }

  // Recompute every item's price server-side — never trust a price from the client.
  const pricedItems = [];
  let subtotal = 0;
  let itemsTotal = 0;

  for (const [index, item] of items.entries()) {
    // The size tier (and so the price) follows from the height. Any
    // client-sent sizeTier is ignored so a 7 ft standee can't be priced as "small".
    const heightIn = Number(item.heightIn);
    const sizeTier = sizeTierForHeight(heightIn);
    const price = await calculatePrice({
      sizeTier,
      material: item.material,
      quantity: item.quantity,
    });
    const textElements = (item.textElements || []).map((el) => ({ style: el.style, text: el.text.trim() }));
    pricedItems.push({
      ...item,
      heightIn,
      widthIn: item.widthIn === undefined || item.widthIn === null ? null : Number(item.widthIn),
      sizeTier,
      textElements,
      image: imageSizes[index],
      price,
    });
    subtotal += price.subtotal;
    itemsTotal += price.total;
  }

  // Shipping is priced for the order as a whole (one first-unit charge).
  const shippingAmount = await calculateOrderShipping({
    country: shippingAddress.country,
    items: pricedItems.map((item) => ({ sizeTier: item.sizeTier, quantity: item.quantity })),
  });
  subtotal = round2(subtotal);
  itemsTotal = round2(itemsTotal);
  // The discount is product-only; shipping is added on top.
  const discountAmount = round2(subtotal - itemsTotal);
  const total = round2(itemsTotal + shippingAmount);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const orderResult = await client.query(
      `INSERT INTO orders
         (customer_email, customer_phone, shipping_address, status, subtotal, discount_amount,
          shipping_amount, total_price, currency, final_sale_accepted_at, final_sale_policy_version,
          customer_name)
       VALUES ($1, $2, $3, 'pending_payment', $4, $5, $6, $7, $8, now(), $9, $10)
       RETURNING *`,
      [
        customerEmail,
        customerPhone,
        shippingAddress,
        subtotal,
        discountAmount,
        shippingAmount,
        total,
        CURRENCY,
        POLICY_VERSION,
        customerName,
      ]
    );
    const order = orderResult.rows[0];

    for (const item of pricedItems) {
      await client.query(
        `INSERT INTO order_items
           (order_id, image_key, size_tier, material, height_in, width_in, text_elements,
            quantity, unit_price, line_total, notes,
            image_width_px, image_height_px, print_ppi, low_quality_accepted, print_score)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          order.id,
          item.imageKey,
          item.sizeTier,
          item.material,
          item.heightIn,
          item.widthIn,
          JSON.stringify(item.textElements),
          item.quantity,
          item.price.unitPrice,
          item.price.total,
          item.notes || null,
          item.image.width,
          item.image.height,
          item.image.ppi,
          item.image.lowAccepted,
          item.image.score,
        ]
      );
    }

    await client.query("COMMIT");
    return getOrderById(order.id);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Rejects malformed IDs with a 400 before they reach Postgres (which would 500). */
function assertOrderId(orderId) {
  if (typeof orderId !== "string" || !UUID_PATTERN.test(orderId)) {
    throw validationError("That isn't a valid order ID.");
  }
}

async function getOrderById(orderId, { email } = {}) {
  assertOrderId(orderId);
  const orderResult = await pool.query("SELECT * FROM orders WHERE id = $1", [orderId]);
  if (orderResult.rowCount === 0) {
    throw notFoundError("Order not found.");
  }
  const order = orderResult.rows[0];

  if (email && order.customer_email.toLowerCase() !== email.toLowerCase()) {
    // Don't reveal that the order exists for a non-matching email.
    throw notFoundError("Order not found.");
  }

  const itemsResult = await pool.query(
    "SELECT * FROM order_items WHERE order_id = $1",
    [orderId]
  );

  return {
    id: order.id,
    customerName: order.customer_name,
    customerEmail: order.customer_email,
    customerPhone: order.customer_phone,
    shippingAddress: order.shipping_address,
    status: order.status,
    subtotal: Number(order.subtotal),
    discountAmount: Number(order.discount_amount),
    shippingAmount: Number(order.shipping_amount),
    totalPrice: Number(order.total_price),
    currency: order.currency,
    finalSaleAcceptedAt: order.final_sale_accepted_at,
    finalSalePolicyVersion: order.final_sale_policy_version,
    stripeSessionId: order.stripe_session_id,
    stripePaymentIntentId: order.stripe_payment_intent_id,
    carrier: order.carrier,
    trackingNumber: order.tracking_number,
    trackingUrl: order.tracking_url,
    shippedAt: order.shipped_at,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
    items: itemsResult.rows.map((i) => ({
      id: i.id,
      imageKey: i.image_key,
      sizeTier: i.size_tier,
      material: i.material,
      heightIn: Number(i.height_in),
      widthIn: i.width_in === null || i.width_in === undefined ? null : Number(i.width_in),
      textElements: i.text_elements || [],
      imageWidthPx: i.image_width_px,
      imageHeightPx: i.image_height_px,
      printPpi: i.print_ppi,
      printScore: i.print_score,
      lowQualityAccepted: Boolean(i.low_quality_accepted),
      quantity: i.quantity,
      unitPrice: Number(i.unit_price),
      lineTotal: Number(i.line_total),
    })),
  };
}

async function setStripeSession(orderId, sessionId) {
  await pool.query("UPDATE orders SET stripe_session_id = $1, updated_at = now() WHERE id = $2", [
    sessionId,
    orderId,
  ]);
}

/**
 * @param {string} orderId
 * @param {string} paymentIntentId
 * @param {Object} [payment]
 * @param {number} [payment.amount] what Stripe actually charged; defaults to the order's total_price
 * @param {string} [payment.currency] Stripe's currency for that amount; defaults to the order's
 * @param {Object} [payment.rawPayload] the webhook event, kept for audit/debugging
 */
async function markOrderPaid(orderId, paymentIntentId, { amount, currency, rawPayload } = {}) {
  assertOrderId(orderId);
  // One statement, so the status change, its audit event and the payment
  // row are all-or-nothing, and written only when the status actually
  // changed — Stripe webhook retries add no duplicates.
  const result = await pool.query(
    `WITH updated AS (
       UPDATE orders
       SET status = 'paid', stripe_payment_intent_id = $1, updated_at = now()
       WHERE id = $2 AND status = 'pending_payment'
       RETURNING id, total_price, currency
     ),
     event AS (
       INSERT INTO order_status_events (order_id, from_status, to_status, changed_by)
       SELECT id, 'pending_payment', 'paid', 'stripe-webhook' FROM updated
     )
     INSERT INTO payments (order_id, provider, provider_txn_id, amount, currency, status, raw_payload)
     SELECT id, 'stripe', $1, COALESCE($3::numeric, total_price), COALESCE($5::text, currency),
            'succeeded', $4
     FROM updated
     RETURNING id`,
    [paymentIntentId, orderId, amount ?? null, rawPayload ?? null, currency ? currency.toUpperCase() : null]
  );
  // `changed` is false on a retry (the order was already paid), so callers
  // can avoid repeating side effects such as emails.
  return { order: await getOrderById(orderId), changed: result.rowCount > 0 };
}

/**
 * Admin status change. Only ALLOWED_TRANSITIONS are accepted (409
 * otherwise); "shipped" needs a carrier and tracking number. The change and
 * its order_status_events row are written in one transaction.
 *
 * @param {string} orderId
 * @param {string} status
 * @param {{ name: string, ip: string, userAgent: string }} actor who made the change, for the audit log
 * @param {{ carrier?: string, trackingNumber?: string, trackingUrl?: string }} [shipping]
 * @returns {Promise<{ order: Object, fromStatus: string }>}
 */
async function updateOrderStatus(orderId, status, actor, shipping = {}) {
  const validStatuses = ["in_production", "shipped", "delivered", "cancelled"];
  if (!validStatuses.includes(status)) {
    throw validationError(`Invalid status: ${status}`);
  }
  assertOrderId(orderId);

  let tracking = null;
  if (status === "shipped") {
    const carrier = typeof shipping.carrier === "string" ? shipping.carrier.trim() : "";
    const trackingNumber = typeof shipping.trackingNumber === "string" ? shipping.trackingNumber.trim() : "";
    const trackingUrl = typeof shipping.trackingUrl === "string" ? shipping.trackingUrl.trim() : "";
    if (!carrier || !trackingNumber) {
      throw validationError("Marking an order shipped needs the carrier and the tracking number.");
    }
    checkLength(carrier, MAX_TRACKING_LENGTH, "Carrier");
    checkLength(trackingNumber, MAX_TRACKING_LENGTH, "Tracking number");
    checkLength(trackingUrl, MAX_TRACKING_URL_LENGTH, "Tracking URL");
    if (trackingUrl && !/^https?:\/\/\S+$/i.test(trackingUrl)) {
      throw validationError("The tracking URL must start with http:// or https://.");
    }
    tracking = { carrier, trackingNumber, trackingUrl: trackingUrl || null };
  }

  const client = await pool.connect();
  let fromStatus;
  try {
    await client.query("BEGIN");
    const current = await client.query("SELECT status FROM orders WHERE id = $1 FOR UPDATE", [orderId]);
    if (current.rowCount === 0) {
      throw notFoundError("Order not found.");
    }
    fromStatus = current.rows[0].status;
    const allowed = ALLOWED_TRANSITIONS[fromStatus] || [];
    if (!allowed.includes(status)) {
      throw conflictError(
        `Can't change an order from "${fromStatus}" to "${status}".` +
          (allowed.length ? ` From "${fromStatus}" it can go to: ${allowed.join(", ")}.` : ` "${fromStatus}" is final.`)
      );
    }

    if (tracking) {
      await client.query(
        `UPDATE orders SET status = $1, carrier = $2, tracking_number = $3, tracking_url = $4,
                shipped_at = now(), updated_at = now()
         WHERE id = $5`,
        [status, tracking.carrier, tracking.trackingNumber, tracking.trackingUrl, orderId]
      );
    } else {
      await client.query("UPDATE orders SET status = $1, updated_at = now() WHERE id = $2", [status, orderId]);
    }
    await client.query(
      `INSERT INTO order_status_events
         (order_id, from_status, to_status, changed_by, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [orderId, fromStatus, status, actor.name, actor.ip, actor.userAgent]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return { order: await getOrderById(orderId), fromStatus };
}

/** The statuses an admin may move an order to next. */
function allowedNextStatuses(status) {
  return ALLOWED_TRANSITIONS[status] || [];
}

// ---------- Internal notes (admin only; never shown to customers) ----------
async function addNote(orderId, body, author) {
  assertOrderId(orderId);
  const text = typeof body === "string" ? body.trim() : "";
  if (!text) throw validationError("A note can't be empty.");
  checkLength(text, MAX_NOTE_LENGTH, "Note");
  const exists = await pool.query("SELECT 1 FROM orders WHERE id = $1", [orderId]);
  if (exists.rowCount === 0) throw notFoundError("Order not found.");
  await pool.query("INSERT INTO order_notes (order_id, body, author) VALUES ($1, $2, $3)", [orderId, text, author]);
  return getNotes(orderId);
}

async function getNotes(orderId) {
  assertOrderId(orderId);
  const result = await pool.query(
    "SELECT id, body, author, created_at FROM order_notes WHERE order_id = $1 ORDER BY created_at",
    [orderId]
  );
  return result.rows.map((n) => ({ id: n.id, body: n.body, author: n.author, createdAt: n.created_at }));
}

async function getStatusEvents(orderId) {
  assertOrderId(orderId);
  const result = await pool.query(
    `SELECT from_status, to_status, changed_by, ip, user_agent, created_at
     FROM order_status_events WHERE order_id = $1 ORDER BY created_at`,
    [orderId]
  );
  return result.rows.map((e) => ({
    fromStatus: e.from_status,
    toStatus: e.to_status,
    changedBy: e.changed_by,
    ip: e.ip,
    userAgent: e.user_agent,
    createdAt: e.created_at,
  }));
}

/**
 * Admin order list, newest first, 25 per page.
 *
 * @param {Object} filters
 * @param {string} [filters.status] "needs_action" (default: paid + in_production), "all", or one status
 * @param {string} [filters.q] matches email, name (substring) or order id (prefix)
 * @param {string} [filters.from] YYYY-MM-DD, inclusive
 * @param {string} [filters.to] YYYY-MM-DD, inclusive
 * @param {number} [filters.page] 1-based
 */
async function listOrders({ status = "needs_action", q, from, to, page = 1 } = {}) {
  const where = [];
  const params = [];
  const param = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (status === "needs_action") {
    where.push("o.status IN ('paid', 'in_production')");
  } else if (status && status !== "all") {
    const statuses = ["pending_payment", "paid", "in_production", "shipped", "delivered", "cancelled"];
    if (!statuses.includes(status)) throw validationError(`Unknown status filter: ${status}`);
    where.push(`o.status = ${param(status)}`);
  }
  const search = typeof q === "string" ? q.trim().slice(0, 200) : "";
  if (search) {
    const like = param(`%${search.replace(/[\\%_]/g, "\\$&")}%`);
    const prefix = param(`${search.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`);
    where.push(`(o.customer_email ILIKE ${like} OR o.customer_name ILIKE ${like} OR o.id::text LIKE ${prefix})`);
  }
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (from) {
    if (!datePattern.test(from)) throw validationError("`from` must be a date (YYYY-MM-DD).");
    where.push(`o.created_at >= ${param(from)}::date`);
  }
  if (to) {
    if (!datePattern.test(to)) throw validationError("`to` must be a date (YYYY-MM-DD).");
    where.push(`o.created_at < (${param(to)}::date + 1)`);
  }

  const pageNumber = Math.max(1, Math.floor(Number(page)) || 1);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const totalResult = await pool.query(`SELECT count(*)::int AS n FROM orders o ${whereSql}`, params);
  const rows = await pool.query(
    `SELECT o.*,
            (SELECT count(*)::int FROM order_items i WHERE i.order_id = o.id) AS item_count,
            (SELECT coalesce(sum(i.quantity), 0)::int FROM order_items i WHERE i.order_id = o.id) AS cutout_count
     FROM orders o ${whereSql}
     ORDER BY o.created_at DESC
     LIMIT ${ADMIN_PAGE_SIZE} OFFSET ${(pageNumber - 1) * ADMIN_PAGE_SIZE}`,
    params
  );

  return {
    orders: rows.rows.map((order) => ({
      id: order.id,
      shortId: order.id.slice(0, 8),
      customerName: order.customer_name,
      customerEmail: order.customer_email,
      status: order.status,
      totalPrice: Number(order.total_price),
      currency: order.currency,
      itemCount: order.item_count,
      cutoutCount: order.cutout_count,
      country: order.shipping_address && order.shipping_address.country,
      createdAt: order.created_at,
    })),
    page: pageNumber,
    pageSize: ADMIN_PAGE_SIZE,
    total: totalResult.rows[0].n,
  };
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

module.exports = {
  createOrder,
  getOrderById,
  setStripeSession,
  markOrderPaid,
  updateOrderStatus,
  getStatusEvents,
  listOrders,
  allowedNextStatuses,
  addNote,
  getNotes,
  FIELD_LIMITS,
};
