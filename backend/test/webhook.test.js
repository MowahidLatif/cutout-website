/** 3. Stripe webhook: signed event marks paid; repeats are idempotent; bad signatures are refused. */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { SRC, useTestDb, useTempUploads, stubStripe, captureEmails, startApp, uploadPhoto, orderInput } = require("./helpers");

let db, app, stripe, emails, orders;

test.before(async () => {
  db = await useTestDb();
  useTempUploads();
  stripe = stubStripe();
  emails = captureEmails();
  process.env.FULFILLMENT_EMAIL = "orders@shop.example.com";
  orders = require(path.join(SRC, "services/orders"));
  app = await startApp();
});
test.beforeEach(async () => {
  await db.reset();
  emails.length = 0;
});
test.after(async () => {
  await app.close();
  await db.close();
});

function completedEvent(order) {
  return JSON.stringify({
    id: "evt_test_1",
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_1",
        object: "checkout.session",
        payment_intent: "pi_test_123",
        amount_total: Math.round(order.totalPrice * 100),
        currency: "cad",
        metadata: { orderId: order.id },
      },
    },
  });
}

const send = (payload, signature) =>
  fetch(`${app.url}/api/webhooks/stripe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Stripe-Signature": signature },
    body: payload,
  });

test("a signed checkout.session.completed marks the order paid, once", async () => {
  const order = await orders.createOrder(orderInput([{ imageKey: await uploadPhoto(), material: "coroplast", heightIn: 68, quantity: 2 }]));
  const payload = completedEvent(order);

  let res = await send(payload, stripe.sign(payload));
  assert.equal(res.status, 200);
  const paid = await orders.getOrderById(order.id);
  assert.equal(paid.status, "paid");
  assert.equal(paid.stripePaymentIntentId, "pi_test_123");
  assert.equal(emails.length, 2, "fulfillment + customer confirmation");
  assert.deepEqual(emails.map((e) => e.to).sort(), ["jane@example.com", "orders@shop.example.com"]);

  // Stripe retries the same event: nothing new happens.
  res = await send(payload, stripe.sign(payload));
  assert.equal(res.status, 200);
  const payments = await db.query("SELECT amount, currency FROM payments WHERE order_id = $1", [order.id]);
  assert.equal(payments.rows.length, 1);
  assert.equal(Number(payments.rows[0].amount), order.totalPrice);
  const events = await db.query("SELECT 1 FROM order_status_events WHERE order_id = $1", [order.id]);
  assert.equal(events.rows.length, 1);
  assert.equal(emails.length, 2, "no second set of emails");
});

test("a bad signature is refused with 400 and changes nothing", async () => {
  const order = await orders.createOrder(orderInput([{ imageKey: await uploadPhoto(), material: "coroplast", heightIn: 68, quantity: 1 }]));
  const payload = completedEvent(order);
  const res = await send(payload, "t=123,v1=deadbeef");
  assert.equal(res.status, 400);
  assert.equal((await orders.getOrderById(order.id)).status, "pending_payment");
  assert.equal(emails.length, 0);
});
