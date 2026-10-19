/** The server enforces the low-quality confirmation itself, from the stored file's real size. */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { SRC, useTestDb, useTempUploads, makeJpeg, ADDRESS } = require("./helpers");

let db, orders, uploads;

test.before(async () => {
  db = await useTestDb();
  useTempUploads();
  orders = require(path.join(SRC, "services/orders"));
  uploads = require(path.join(SRC, "services/uploads"));
});

const order = (item) =>
  orders.createOrder({ customerEmail: "a@b.co", customerPhone: "1", shippingAddress: ADDRESS, acceptedFinalSale: true, items: [item] });

test("a low-quality photo is refused without the customer's confirmation", async () => {
  const { imageKey } = await uploads.processUpload(await makeJpeg(588, 900));
  await assert.rejects(
    order({ imageKey, material: "coroplast", heightIn: 72, quantity: 1 }),
    /Photo 1 will print at low quality at this size \(13 pixels per inch\)/
  );
});

test("…accepted with it, and the measurement and confirmation are stored", async () => {
  const { imageKey } = await uploads.processUpload(await makeJpeg(588, 900));
  const o = await order({ imageKey, material: "coroplast", heightIn: 72, quantity: 1, acceptedLowQuality: true });
  const row = (await db.query("SELECT image_width_px, image_height_px, print_ppi, low_quality_accepted FROM order_items WHERE order_id = $1", [o.id])).rows[0];
  assert.deepEqual(row, { image_width_px: 588, image_height_px: 900, print_ppi: 13, low_quality_accepted: true });
});

test("the same small photo at a small size needs no confirmation", async () => {
  const { imageKey } = await uploads.processUpload(await makeJpeg(588, 900));
  const o = await order({ imageKey, material: "coroplast", heightIn: 24, quantity: 1 });
  assert.equal(o.items[0].printPpi, 38); // 900 px over 24 in → "good"
  assert.equal(o.items[0].lowQualityAccepted, false);
});

test("a sharp photo needs no confirmation and isn't marked as accepted-low", async () => {
  const { imageKey } = await uploads.processUpload(await makeJpeg(3024, 4032));
  const o = await order({ imageKey, material: "coroplast", heightIn: 72, quantity: 1, acceptedLowQuality: true });
  assert.equal(o.items[0].lowQualityAccepted, false);
});
