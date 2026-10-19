/**
 * What the customer picks in the studio must be exactly what's stored and
 * charged: "Premium Corrugated" is corrugated plastic (`coroplast`) — it must
 * not silently become another material, and the quantity must survive
 * unchanged into order_items and the Stripe description.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { SRC, useTestDb, useTempUploads, stubStripe, loadFrontend, makeJpeg, ADDRESS } = require("./helpers");

let db, orders, uploads, stripe, catalog, sent, SITE;

test.before(async () => {
  db = await useTestDb();
  useTempUploads();
  sent = stubStripe();
  orders = require(path.join(SRC, "services/orders"));
  uploads = require(path.join(SRC, "services/uploads"));
  stripe = require(path.join(SRC, "services/stripe"));
  catalog = require(path.join(SRC, "services/catalog"));
  SITE = loadFrontend("js/site-config.js").SITE;
});

test("every storefront material maps to a valid backend material with a matching label", async () => {
  const allowed = (await db.query("SELECT DISTINCT material FROM pricing_config")).rows.map((r) => r.material);
  for (const m of SITE.materials) {
    assert.ok(allowed.includes(m.id), `${m.id} is priced in pricing_config`);
    assert.ok(catalog.MATERIAL_LABELS[m.id], `${m.id} has a backend label`);
    assert.ok(
      catalog.MATERIAL_LABELS[m.id].startsWith(m.name),
      `backend label "${catalog.MATERIAL_LABELS[m.id]}" starts with the storefront name "${m.name}"`
    );
  }
});

test('"Premium Corrugated" is corrugated plastic (coroplast), and the UI says so', () => {
  const corrugated = SITE.materials.find((m) => m.name === "Premium Corrugated");
  assert.equal(corrugated.id, "coroplast");
  assert.match(corrugated.detail, /corrugated plastic/i);
  assert.match(catalog.MATERIAL_LABELS.coroplast, /corrugated plastic/i);
  // The only material the storefront lets customers order right now.
  // (Values from the frontend sandbox come from another JS realm, so compare as JSON.)
  assert.equal(JSON.stringify(SITE.materials.filter((m) => !m.comingSoon).map((m) => m.id)), '["coroplast"]');
});

test("the chosen material and quantity are stored and sent to Stripe exactly", async () => {
  const studioChoice = SITE.materials.find((m) => !m.comingSoon); // what the studio sends
  const { imageKey } = await uploads.processUpload(await makeJpeg(3000, 4000));
  const order = await orders.createOrder({
    customerEmail: "a@b.co",
    customerPhone: "1",
    shippingAddress: ADDRESS,
    acceptedFinalSale: true,
    // As the studio sends it: height, the width from the photo's proportions, quantity.
    items: [{ imageKey, material: studioChoice.id, heightIn: 68, widthIn: 51, quantity: 7 }],
  });

  const row = (await db.query("SELECT material, quantity FROM order_items WHERE order_id = $1", [order.id])).rows[0];
  assert.equal(row.material, "coroplast");
  assert.equal(row.quantity, 7);

  await stripe.createCheckoutSession(order);
  const line = sent.params.line_items[0].price_data;
  assert.match(line.product_data.description, /^7 × Life-size 5'8" × 4'3" — Premium Corrugated \(corrugated plastic \/ Coroplast\)$/);
  assert.equal(line.unit_amount, Math.round(order.totalPrice * 100));
  assert.equal(line.currency, "cad");
});

test("cardboard stays cardboard (no silent remapping)", async () => {
  const { imageKey } = await uploads.processUpload(await makeJpeg(3000, 4000));
  const order = await orders.createOrder({
    customerEmail: "a@b.co",
    customerPhone: "1",
    shippingAddress: ADDRESS,
    acceptedFinalSale: true,
    items: [{ imageKey, material: "cardboard", heightIn: 68, quantity: 2 }],
  });
  assert.equal(order.items[0].material, "cardboard");
  assert.match(stripe.buildSessionParams(order).line_items[0].price_data.product_data.description, /^2 × .*Corrugated cardboard$/);
});
