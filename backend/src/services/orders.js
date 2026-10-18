const pool = require("../db/pool");
const { calculatePrice, calculateShipping, sizeTierForHeight, HEIGHT_RANGE_IN, CURRENCY } = require("./pricing");
const storage = require("./storage");

const VALID_MATERIALS = ["cardboard", "coroplast", "foam_board", "acrylic"];
const VALID_COUNTRIES = ["CA", "US"];
const WIDTH_RANGE_IN = { min: 6, max: 96 };
const TEXT_STYLES = ["bubble", "placard", "caption"];
const MAX_TEXT_ELEMENTS = 3;
const MAX_TEXT_LENGTH = 80;
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

function validateOrderInput({ customerEmail, customerPhone, shippingAddress, items, acceptedFinalSale }) {
  if (acceptedFinalSale !== true) {
    throw validationError(
      "Please confirm you understand each standee is custom-made and final sale (no returns or refunds)."
    );
  }
  if (!customerEmail || !/^\S+@\S+\.\S+$/.test(customerEmail)) {
    throw validationError("A valid customerEmail is required.");
  }
  if (!customerPhone) {
    throw validationError("customerPhone is required.");
  }
  if (!shippingAddress || !shippingAddress.line1 || !shippingAddress.city) {
    throw validationError("shippingAddress with at least line1 and city is required.");
  }
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
    if (!Number.isInteger(item.quantity) || item.quantity < 1) {
      throw validationError("Each item needs a whole-number quantity of at least 1.");
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
    if (!storage.isValidKey(item.imageKey)) {
      throw validationError("Each item needs an imageKey from POST /api/uploads.");
    }
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

  // A well-formed key isn't enough — it must be a file we actually stored.
  for (const item of items) {
    if (!(await storage.fileExists(item.imageKey))) {
      throw validationError("Uploaded photo not found. Please upload it again.");
    }
  }

  // Recompute every item's price server-side — never trust a price from the client.
  const pricedItems = [];
  let subtotal = 0;
  let itemsTotal = 0;
  let shippingAmount = 0;

  for (const item of items) {
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
      price,
    });
    subtotal += price.subtotal;
    itemsTotal += price.total;
    shippingAmount += await calculateShipping({
      country: shippingAddress.country,
      sizeTier,
      quantity: item.quantity,
    });
  }

  subtotal = round2(subtotal);
  itemsTotal = round2(itemsTotal);
  shippingAmount = round2(shippingAmount);
  // The discount is product-only; shipping is added on top.
  const discountAmount = round2(subtotal - itemsTotal);
  const total = round2(itemsTotal + shippingAmount);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const orderResult = await client.query(
      `INSERT INTO orders
         (customer_email, customer_phone, shipping_address, status, subtotal, discount_amount,
          shipping_amount, total_price, currency, final_sale_accepted_at, final_sale_policy_version)
       VALUES ($1, $2, $3, 'pending_payment', $4, $5, $6, $7, $8, now(), $9)
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
      ]
    );
    const order = orderResult.rows[0];

    for (const item of pricedItems) {
      await client.query(
        `INSERT INTO order_items
           (order_id, image_key, size_tier, material, height_in, width_in, text_elements,
            quantity, unit_price, line_total, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
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

/** A malformed ID can't match any order — 404 here instead of a Postgres type error (500). */
function assertOrderId(orderId) {
  if (typeof orderId !== "string" || !UUID_PATTERN.test(orderId)) {
    throw notFoundError("Order not found.");
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
  await pool.query(
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
     FROM updated`,
    [paymentIntentId, orderId, amount ?? null, rawPayload ?? null, currency ? currency.toUpperCase() : null]
  );
  return getOrderById(orderId);
}

/**
 * @param {string} orderId
 * @param {string} status
 * @param {{ name: string, ip: string, userAgent: string }} actor who made the change, for the audit log
 * @returns {Promise<{ order: Object, fromStatus: string }>}
 */
async function updateOrderStatus(orderId, status, actor) {
  const validStatuses = ["in_production", "shipped", "delivered", "cancelled"];
  if (!validStatuses.includes(status)) {
    throw validationError(`Invalid status: ${status}`);
  }
  assertOrderId(orderId);

  const client = await pool.connect();
  let fromStatus;
  try {
    await client.query("BEGIN");
    const current = await client.query("SELECT status FROM orders WHERE id = $1 FOR UPDATE", [orderId]);
    if (current.rowCount === 0) {
      throw notFoundError("Order not found.");
    }
    fromStatus = current.rows[0].status;
    if (fromStatus === status) {
      // Also stops a repeated "shipped" from re-emailing the customer.
      throw validationError(`Order is already ${status}.`);
    }

    await client.query("UPDATE orders SET status = $1, updated_at = now() WHERE id = $2", [
      status,
      orderId,
    ]);
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

async function listOrders({ status } = {}) {
  const result = status
    ? await pool.query("SELECT * FROM orders WHERE status = $1 ORDER BY created_at DESC", [status])
    : await pool.query("SELECT * FROM orders ORDER BY created_at DESC");

  return result.rows.map((order) => ({
    id: order.id,
    customerEmail: order.customer_email,
    status: order.status,
    totalPrice: Number(order.total_price),
    createdAt: order.created_at,
  }));
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
};
