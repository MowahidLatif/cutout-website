const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { SRC, useTestDb, useTempUploads, uploadPhoto, makeCutoutPng, orderInput } = require("./helpers");

let db, email, orders;

test.before(async () => {
  db = await useTestDb();
  useTempUploads();
  process.env.SITE_URL = "https://shop.example.com";
  process.env.FULFILLMENT_EMAIL = "orders@shop.example.com";
  orders = require(path.join(SRC, "services/orders"));
  email = require(path.join(SRC, "services/email"));
});
test.beforeEach(() => db.reset());
test.after(() => db.close());

async function makeOrder(items) {
  for (const item of items) item.imageKey = await uploadPhoto();
  return orders.createOrder(orderInput(items));
}

test("one cutout is singular", async () => {
  const order = await makeOrder([{ material: "coroplast", heightIn: 68, quantity: 1 }]);
  const { body } = email.buildCustomerConfirmation(order);
  assert.match(body, /Items \(1 cutout, 1 design\):/);
  assert.match(body, /1\. 1 cutout — /);
  assert.doesNotMatch(body, /1 cutouts|1 designs/);
});

test("both emails list every item in full, with plurals, final-sale text and site links", async () => {
  const order = await makeOrder([
    { material: "coroplast", heightIn: 68, widthIn: 51, quantity: 3, textElements: [{ style: "bubble", text: "Happy 40th, Dave!" }] },
    { material: "coroplast", heightIn: 30, quantity: 2 },
  ]);
  const customer = email.buildCustomerConfirmation(order);
  const fulfillment = email.buildFulfillmentEmail(order);

  for (const { body } of [customer, fulfillment]) {
    assert.match(body, /Customer: Jane Doe — jane@example\.com/);
    assert.match(body, /Items \(5 cutouts, 2 designs\):/);
    assert.match(body, /1\. 3 cutouts — Premium Corrugated \(corrugated plastic \/ Coroplast\)/);
    assert.match(body, /Size: Life-size, 5'8" tall × 4'3" wide/);
    assert.match(body, /Speech bubble: "Happy 40th, Dave!"/);
    assert.match(body, /2\. 2 cutouts — Premium Corrugated/);
    assert.match(body, /Size: Small, 2'6" tall/);
    const links = body.match(/Image \(link expires \d{4}-\d{2}-\d{2}\): https:\/\/shop\.example\.com\/api\/files\/\S+/g) || [];
    assert.equal(links.length, 2);
    assert.match(body, /Print quality: Great — 100\/100 \(\d+ pixels per inch\)/);
    assert.match(body, /Total: \$\d+\.\d{2} CAD/);
    assert.ok(body.includes(`https://shop.example.com/order-status?order=${order.id}`));
  }
  assert.equal(fulfillment.to, "orders@shop.example.com");
  assert.ok(customer.body.includes("we can't accept returns or give refunds."));
});

test("transparency is read from the stored file and tells the supplier how to cut", async () => {
  const { processUpload } = require(path.join(SRC, "services/uploads"));
  const cutout = (await processUpload(await makeCutoutPng(600, 900))).imageKey;
  const order = await orders.createOrder(
    orderInput([
      { material: "coroplast", heightIn: 12, quantity: 1, imageKey: cutout }, // small: the fixture is only 900px tall
      { material: "coroplast", heightIn: 68, quantity: 1, imageKey: await uploadPhoto() },
    ])
  );
  const saved = await orders.getOrderById(order.id);
  assert.deepEqual(saved.items.map((i) => i.hasTransparency), [true, false]);
  const { body } = email.buildFulfillmentEmail(saved);
  assert.match(body, /Background: removed — transparent PNG, cut along the outline[\s\S]*Background: kept \(print the whole photo\)/);
});

test("border colour and notes are validated, stored, and shown to the supplier", async () => {
  const key = await uploadPhoto();
  const item = (extra) => ({ material: "coroplast", heightIn: 68, quantity: 1, imageKey: key, ...extra });
  for (const borderColor of ["#123456", "white", "#FFF", 42]) {
    await assert.rejects(orders.createOrder(orderInput([item({ borderColor })])), /Border colour must be one of/);
  }
  await assert.rejects(orders.createOrder(orderInput([item({ notes: "x".repeat(151) })])), /at most 150 characters/);

  const order = await orders.createOrder(
    orderInput([item({ borderColor: "#000000", notes: "Please keep\nthe hat in the cut" }), item({ borderColor: null })])
  );
  assert.deepEqual(order.items.map((i) => [i.borderColor, i.notes]), [["#000000", "Please keep the hat in the cut"], [null, null]]);
  const lowercase = await orders.createOrder(orderInput([item({ borderColor: "#f28c28", notes: "x".repeat(150) })]));
  assert.equal(lowercase.items[0].borderColor, "#F28C28");

  const { body } = email.buildFulfillmentEmail(order);
  assert.match(body, /Border: Black \(#000000\)\n   Notes: Please keep the hat in the cut/);
  assert.match(body, /Border: none/);
});

test("the shipped email includes carrier, tracking and the status link", async () => {
  const order = await makeOrder([{ material: "coroplast", heightIn: 68, quantity: 1 }]);
  const { body } = email.buildShippedNotification({
    ...order,
    carrier: "UPS",
    trackingNumber: "1Z999AA10123456784",
    trackingUrl: "https://www.ups.com/track?tracknum=1Z999AA10123456784",
  });
  assert.match(body, /Good news, Jane Doe/);
  assert.match(body, /Carrier: UPS/);
  assert.match(body, /Tracking number: 1Z999AA10123456784/);
  assert.match(body, /Track your package: https:\/\/www\.ups\.com/);
  assert.ok(body.includes(`https://shop.example.com/order-status?order=${order.id}`));
});
