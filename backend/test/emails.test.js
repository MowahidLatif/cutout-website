const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { SRC, useTestDb, useTempUploads, makeJpeg, ADDRESS } = require("./helpers");

let email, orders, uploads;

test.before(async () => {
  await useTestDb();
  useTempUploads();
  process.env.SITE_URL = "https://shop.example.com";
  process.env.FULFILLMENT_EMAIL = "orders@shop.example.com";
  orders = require(path.join(SRC, "services/orders"));
  uploads = require(path.join(SRC, "services/uploads"));
  email = require(path.join(SRC, "services/email"));
});

async function makeOrder(items) {
  for (const item of items) {
    item.imageKey = (await uploads.processUpload(await makeJpeg(3000, 4000))).imageKey;
  }
  return orders.createOrder({
    customerEmail: "jane@example.com",
    customerPhone: "204-555-0100",
    shippingAddress: ADDRESS,
    acceptedFinalSale: true,
    items,
  });
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
    {
      material: "coroplast",
      heightIn: 68,
      widthIn: 51,
      quantity: 3,
      textElements: [{ style: "bubble", text: "Happy 40th, Dave!" }],
    },
    { material: "coroplast", heightIn: 30, quantity: 2 },
  ]);
  const customer = email.buildCustomerConfirmation(order);
  const fulfillment = email.buildFulfillmentEmail(order);

  for (const { body } of [customer, fulfillment]) {
    assert.match(body, /Items \(5 cutouts, 2 designs\):/);
    // Item 1: quantity, material, size, speech bubble, image link.
    assert.match(body, /1\. 3 cutouts — Premium Corrugated \(corrugated plastic \/ Coroplast\)/);
    assert.match(body, /Size: Life-size, 5'8" tall × 4'3" wide/);
    assert.match(body, /Speech bubble: "Happy 40th, Dave!"/);
    // Item 2.
    assert.match(body, /2\. 2 cutouts — Premium Corrugated/);
    assert.match(body, /Size: Small, 2'6" tall/);
    // An image link per item, on the configured site.
    const links = body.match(/Image \(link expires \d{4}-\d{2}-\d{2}\): https:\/\/shop\.example\.com\/api\/files\/\S+/g) || [];
    assert.equal(links.length, 2);
    assert.match(body, /Print quality: Great \(\d+ pixels per inch\)/);
    assert.match(body, /Total: \$\d+\.\d{2} CAD/);
    // Status link uses SITE_URL.
    assert.ok(body.includes(`https://shop.example.com/order-status?order=${order.id}`));
  }

  assert.equal(fulfillment.to, "orders@shop.example.com");
  assert.equal(customer.to, "jane@example.com");
  assert.ok(customer.body.includes("we can't accept returns or give refunds."));
  assert.doesNotMatch(customer.body, /giverefunds/);
});

test("the shipped email links to the order status on the site", async () => {
  const order = await makeOrder([{ material: "coroplast", heightIn: 68, quantity: 1 }]);
  const { body } = email.buildShippedNotification(order);
  assert.ok(body.includes(`https://shop.example.com/order-status?order=${order.id}`));
});
