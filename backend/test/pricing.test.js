/** 1. The price the server charges equals the browser's live quote (shared formula). */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { SRC, useTestDb, useTempUploads, loadFrontend, uploadPhoto, orderInput } = require("./helpers");

let db, pricing, orders, client, config;

test.before(async () => {
  db = await useTestDb();
  useTempUploads();
  pricing = require(path.join(SRC, "services/pricing"));
  orders = require(path.join(SRC, "services/orders"));
  client = loadFrontend("js/pricing.js").Pricing;
  config = await pricing.getPricingConfig();
});
test.beforeEach(() => db.reset());
test.after(() => db.close());

const combos = [
  { heightIn: 30, material: "coroplast", quantity: 1 }, // small, no discount
  { heightIn: 48, material: "cardboard", quantity: 3 }, // medium, 5%
  { heightIn: 68, material: "coroplast", quantity: 7 }, // life-size, 10%
  { heightIn: 84, material: "acrylic", quantity: 12 }, // XL, 15%
  { heightIn: 72, material: "foam_board", quantity: 25 }, // life-size, 20%
];

test("per-item price: server = client for every size tier and discount tier", async () => {
  for (const c of combos) {
    const sizeTier = pricing.sizeTierForHeight(c.heightIn);
    assert.equal(client.sizeTierForHeight(c.heightIn), sizeTier);
    const server = await pricing.calculatePrice({ sizeTier, material: c.material, quantity: c.quantity });
    const browser = client.calculatePrice({ sizeTier, material: c.material, quantity: c.quantity, rates: config.rates, discountTiers: config.discountTiers });
    assert.equal(JSON.stringify(browser), JSON.stringify(server), JSON.stringify(c));
  }
});

test("order shipping: server = client for mixed orders to CA and US", async () => {
  for (const country of ["CA", "US"]) {
    const items = combos.map((c) => ({ sizeTier: pricing.sizeTierForHeight(c.heightIn), quantity: c.quantity }));
    assert.equal(client.calculateOrderShipping({ country, items, shippingRates: config.shippingRates }), await pricing.calculateOrderShipping({ country, items }));
  }
});

test("a whole order's stored totals equal the browser's checkout total", async () => {
  const items = [];
  for (const c of combos.slice(0, 3)) items.push({ ...c, imageKey: await uploadPhoto(1200, 1600) });
  const order = await orders.createOrder(orderInput(items.map((i) => ({ ...i, acceptedLowQuality: true }))));

  let subtotal = 0;
  let itemsTotal = 0;
  const shippingItems = [];
  for (const c of combos.slice(0, 3)) {
    const sizeTier = client.sizeTierForHeight(c.heightIn);
    const p = client.calculatePrice({ sizeTier, material: c.material, quantity: c.quantity, rates: config.rates, discountTiers: config.discountTiers });
    subtotal += p.subtotal;
    itemsTotal += p.total;
    shippingItems.push({ sizeTier, quantity: c.quantity });
  }
  const shipping = client.calculateOrderShipping({ country: "CA", items: shippingItems, shippingRates: config.shippingRates });
  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  assert.equal(order.subtotal, round2(subtotal));
  assert.equal(order.discountAmount, round2(subtotal - itemsTotal));
  assert.equal(order.shippingAmount, shipping);
  assert.equal(order.totalPrice, round2(itemsTotal + shipping));
});
