/** 2. Order creation over HTTP: valid succeeds; limits are enforced. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { useTestDb, useTempUploads, startApp, uploadPhoto, orderInput } = require("./helpers");

let db, app, photo;

test.before(async () => {
  db = await useTestDb();
  useTempUploads();
  app = await startApp();
  photo = await uploadPhoto(3000, 4000);
});
test.beforeEach(() => db.reset());
test.after(async () => {
  await app.close();
  await db.close();
});

const post = (body) =>
  fetch(`${app.url}/api/orders`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const item = (overrides = {}) => ({ imageKey: photo, material: "coroplast", heightIn: 68, quantity: 1, ...overrides });

test("a valid order is created", async () => {
  const res = await post(orderInput([item({ quantity: 3 })]));
  assert.equal(res.status, 201);
  const { data } = await res.json();
  assert.equal(data.status, "pending_payment");
  assert.equal(data.customerName, "Jane Doe");
  assert.equal(data.items[0].quantity, 3);
});

test("over 500 cutouts is rejected", async () => {
  const res = await post(orderInput([item({ quantity: 300 }), item({ quantity: 201 })]));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /at most 500 cutouts \(this one has 501\)/);
});

test("over 10 photos is rejected", async () => {
  const keys = [];
  for (let i = 0; i < 11; i++) keys.push(await uploadPhoto(600, 800));
  const res = await post(orderInput(keys.map((imageKey) => item({ imageKey, heightIn: 12 }))));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /at most 10 different photos \(this one has 11\)/);
});

test("a country other than CA/US is rejected", async () => {
  const res = await post(orderInput([item()], { shippingAddress: { line1: "1 Rue", city: "Paris", region: "IDF", postalCode: "75001", country: "FR" } }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /only ship to CA and US/);
});

test("over-long text and names are rejected", async () => {
  let res = await post(orderInput([item({ textElements: [{ style: "bubble", text: "x".repeat(101) }] })]));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /1–100 characters/);
  res = await post(orderInput([item()], { customerName: "x".repeat(101) }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /Name must be at most 100 characters/);
});

test("a malformed order ID is a 400, not a database error", async () => {
  const res = await fetch(`${app.url}/api/orders/not-a-uuid?email=a@b.co`);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "VALIDATION_ERROR");
});
