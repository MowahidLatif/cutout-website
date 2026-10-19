/** The server enforces the low-quality confirmation itself, from the stored file's real size. */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { SRC, useTestDb, useTempUploads, uploadPhoto, orderInput } = require("./helpers");

let db, orders;
test.before(async () => {
  db = await useTestDb();
  useTempUploads();
  orders = require(path.join(SRC, "services/orders"));
});
test.beforeEach(() => db.reset());
test.after(() => db.close());

const order = async (item) => orders.createOrder(orderInput([item]));

test("a low-quality photo is refused without the customer's confirmation", async () => {
  const imageKey = await uploadPhoto(588, 900);
  await assert.rejects(order({ imageKey, material: "coroplast", heightIn: 72, quantity: 1 }), /Photo 1 will print at low quality at this size \(score 26\/100/);
});

test("…accepted with it, and the measurement, score and confirmation are stored", async () => {
  const imageKey = await uploadPhoto(588, 900);
  const o = await order({ imageKey, material: "coroplast", heightIn: 72, quantity: 1, acceptedLowQuality: true });
  const row = (await db.query("SELECT image_width_px, image_height_px, print_ppi, print_score, low_quality_accepted FROM order_items WHERE order_id = $1", [o.id])).rows[0];
  assert.deepEqual({ ...row }, { image_width_px: 588, image_height_px: 900, print_ppi: 13, print_score: 26, low_quality_accepted: true });
});

test("a small photo at a small size is fair at best and needs no confirmation", async () => {
  const o = await order({ imageKey: await uploadPhoto(588, 900), material: "coroplast", heightIn: 24, quantity: 1 });
  assert.equal(o.items[0].printScore, 59);
  assert.equal(o.items[0].lowQualityAccepted, false);
});
