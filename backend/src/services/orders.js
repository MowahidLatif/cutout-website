const pool = require("../db/pool");
const { calculatePrice, calculateShipping } = require("./pricing");
const storage = require("./storage");

const VALID_SIZE_TIERS = ["small", "medium", "life_size", "xl"];
const VALID_MATERIALS = ["cardboard", "coroplast", "foam_board", "acrylic"];
const VALID_COUNTRIES = ["CA", "US"];

function validationError(message) {
  return Object.assign(new Error(message), { code: "VALIDATION_ERROR" });
}

function notFoundError(message) {
  return Object.assign(new Error(message), { code: "NOT_FOUND" });
}

function validateOrderInput({ customerEmail, customerPhone, shippingAddress, items }) {
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
    if (!VALID_SIZE_TIERS.includes(item.sizeTier)) {
      throw validationError(`Invalid sizeTier: ${item.sizeTier}`);
    }
    if (!VALID_MATERIALS.includes(item.material)) {
      throw validationError(`Invalid material: ${item.material}`);
    }
    if (!item.quantity || item.quantity < 1) {
      throw validationError("Each item needs a quantity of at least 1.");
    }
    if (!item.heightIn || item.heightIn <= 0) {
      throw validationError("Each item needs a positive heightIn.");
    }
    if (!storage.isValidKey(item.imageKey)) {
      throw validationError("Each item needs an imageKey from POST /api/uploads.");
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
    const price = await calculatePrice({
      sizeTier: item.sizeTier,
      material: item.material,
      quantity: item.quantity,
    });
    pricedItems.push({ ...item, price });
    subtotal += price.subtotal;
    itemsTotal += price.total;
    shippingAmount += await calculateShipping({
      country: shippingAddress.country,
      sizeTier: item.sizeTier,
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
         (customer_email, customer_phone, shipping_address, status, subtotal, discount_amount, shipping_amount, total_price)
       VALUES ($1, $2, $3, 'pending_payment', $4, $5, $6, $7)
       RETURNING *`,
      [customerEmail, customerPhone, shippingAddress, subtotal, discountAmount, shippingAmount, total]
    );
    const order = orderResult.rows[0];

    for (const item of pricedItems) {
      await client.query(
        `INSERT INTO order_items
           (order_id, image_key, size_tier, material, height_in, quantity, unit_price, line_total, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          order.id,
          item.imageKey,
          item.sizeTier,
          item.material,
          item.heightIn,
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

async function getOrderById(orderId, { email } = {}) {
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
    stripeSessionId: order.stripe_session_id,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
    items: itemsResult.rows.map((i) => ({
      id: i.id,
      imageKey: i.image_key,
      sizeTier: i.size_tier,
      material: i.material,
      heightIn: Number(i.height_in),
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

async function markOrderPaid(orderId, paymentIntentId) {
  // One statement, so the audit event is written only when the status
  // actually changed — Stripe webhook retries don't add duplicate events.
  await pool.query(
    `WITH updated AS (
       UPDATE orders
       SET status = 'paid', stripe_payment_intent_id = $1, updated_at = now()
       WHERE id = $2 AND status = 'pending_payment'
       RETURNING id
     )
     INSERT INTO order_status_events (order_id, from_status, to_status, changed_by)
     SELECT id, 'pending_payment', 'paid', 'stripe-webhook' FROM updated`,
    [paymentIntentId, orderId]
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
