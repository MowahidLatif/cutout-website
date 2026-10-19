/** 4. Admin API: auth, listing, guarded transitions, tracking, history, notes, supplier bundle. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { SRC, useTestDb, useTempUploads, captureEmails, startApp, uploadPhoto, orderInput } = require("./helpers");

const TOKEN = "t".repeat(40);
let db, app, emails, orders;

test.before(async () => {
  process.env.ADMIN_TOKEN = TOKEN;
  db = await useTestDb();
  useTempUploads();
  emails = captureEmails();
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

const auth = { Authorization: `Bearer ${TOKEN}`, "X-Admin-Name": "Owner" };
const api = (pathname, { method = "GET", body, headers = auth } = {}) =>
  fetch(`${app.url}/api${pathname}`, {
    method,
    headers: { ...headers, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

async function paidOrder(overrides = {}) {
  const order = await orders.createOrder(
    orderInput(
      [{ imageKey: await uploadPhoto(), material: "coroplast", heightIn: 68, quantity: 2, textElements: [{ style: "bubble", text: "Hi!" }] }],
      overrides
    )
  );
  await orders.markOrderPaid(order.id, "pi_test", { amount: order.totalPrice, currency: "CAD" });
  return order;
}

test("no token or a wrong token is a 401", async () => {
  assert.equal((await api("/admin/orders", { headers: {} })).status, 401);
  assert.equal((await api("/admin/orders", { headers: { Authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await api("/admin/orders", { headers: { "X-Admin-Token": TOKEN } })).status, 401, "old header no longer accepted");
});

test("the right token lists orders: needs-action by default, filters, search, pagination", async () => {
  const paid = await paidOrder({ customerName: "Acme Events", customerEmail: "events@acme.co" });
  await orders.createOrder(orderInput([{ imageKey: await uploadPhoto(), material: "coroplast", heightIn: 68, quantity: 1 }])); // pending

  let res = await api("/admin/orders");
  assert.equal(res.status, 200);
  let { data } = await res.json();
  assert.equal(data.total, 1);
  assert.equal(data.pageSize, 25);
  const row = data.orders[0];
  assert.equal(row.id, paid.id);
  assert.equal(row.shortId, paid.id.slice(0, 8));
  assert.equal(row.customerName, "Acme Events");
  assert.equal(row.itemCount, 1);
  assert.equal(row.cutoutCount, 2);
  assert.equal(row.country, "CA");

  data = (await (await api("/admin/orders?status=all")).json()).data;
  assert.equal(data.total, 2);
  data = (await (await api("/admin/orders?status=all&q=acme")).json()).data;
  assert.equal(data.total, 1);
  data = (await (await api(`/admin/orders?status=all&q=${paid.id.slice(0, 8)}`)).json()).data;
  assert.equal(data.total, 1);
  data = (await (await api("/admin/orders?status=all&from=2000-01-01&to=2000-12-31")).json()).data;
  assert.equal(data.total, 0);
});

test("only allowed transitions; shipped needs tracking; each change is in the history", async () => {
  const order = await paidOrder();
  const change = (body) => api(`/admin/orders/${order.id}/status`, { method: "PATCH", body });

  let res = await change({ status: "delivered" });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error.message, /Can't change an order from "paid" to "delivered"/);
  assert.equal((await change({ status: "shipped", carrier: "UPS", trackingNumber: "1Z" })).status, 409);

  assert.equal((await change({ status: "in_production" })).status, 200);

  res = await change({ status: "shipped" });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /needs the carrier and the tracking number/);

  res = await change({ status: "shipped", carrier: "UPS", trackingNumber: "1Z999AA10123456784", trackingUrl: "https://ups.example/track/1Z" });
  assert.equal(res.status, 200);
  const shipped = (await res.json()).data;
  assert.equal(shipped.status, "shipped");
  assert.equal(shipped.trackingNumber, "1Z999AA10123456784");
  assert.equal(shipped.warning, null);
  const shippedEmail = emails.find((e) => e.subject === "Your cutout has shipped!");
  assert.ok(shippedEmail, "shipped email sent");
  assert.match(shippedEmail.body, /Carrier: UPS\nTracking number: 1Z999AA10123456784/);

  assert.equal((await change({ status: "in_production" })).status, 409, "can't go backwards");

  const events = (await db.query("SELECT from_status, to_status, changed_by FROM order_status_events WHERE order_id = $1 ORDER BY created_at", [order.id])).rows;
  assert.deepEqual(events.map((e) => `${e.from_status}→${e.to_status}`), ["pending_payment→paid", "paid→in_production", "in_production→shipped"]);
  assert.equal(events[2].changed_by, "Owner");
});

test("a failed shipped email keeps the status change and returns a warning", async () => {
  const order = await paidOrder();
  await orders.updateOrderStatus(order.id, "in_production", { name: "t" });
  const original = console.log;
  console.log = (...args) => {
    if (String(args[0]).includes("Your cutout has shipped!")) throw new Error("SMTP down");
    original(...args);
  };
  try {
    const res = await api(`/admin/orders/${order.id}/status`, { method: "PATCH", body: { status: "shipped", carrier: "UPS", trackingNumber: "1Z" } });
    assert.equal(res.status, 200);
    const { data } = await res.json();
    assert.equal(data.status, "shipped");
    assert.match(data.warning, /shipped email .* failed to send: SMTP down/);
  } finally {
    console.log = original;
  }
});

test("internal notes are saved, listed with the order, and not shown to customers", async () => {
  const order = await paidOrder();
  let res = await api(`/admin/orders/${order.id}/notes`, { method: "POST", body: { body: "Supplier confirmed by email." } });
  assert.equal(res.status, 201);
  assert.equal((await api(`/admin/orders/${order.id}/notes`, { method: "POST", body: { body: "x".repeat(2001) } })).status, 400);
  const detail = (await (await api(`/admin/orders/${order.id}`)).json()).data;
  assert.equal(detail.notes.length, 1);
  assert.equal(detail.notes[0].author, "Owner");
  assert.deepEqual(detail.allowedNextStatuses, ["in_production", "cancelled"]);
  const customer = await (await fetch(`${app.url}/api/orders/${order.id}?email=jane@example.com`)).json();
  assert.ok(!JSON.stringify(customer).includes("Supplier confirmed"));
});

test("the supplier bundle is a zip of the order details and images, named by order id", async () => {
  const order = await paidOrder();
  const res = await api(`/admin/orders/${order.id}/bundle`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/zip");
  assert.match(res.headers.get("content-disposition"), new RegExp(`${order.id}-supplier-bundle\\.zip`));
  const zip = Buffer.from(await res.arrayBuffer());
  assert.equal(zip.subarray(0, 2).toString(), "PK");
  assert.ok(zip.includes(`${order.id}-order-details.txt`));
  assert.ok(zip.includes(`${order.id}-item-1.jpg`));

  // Unzip it for real when the system has `unzip` (macOS/Linux do).
  let hasUnzip = true;
  try { execFileSync("unzip", ["-v"], { stdio: "ignore" }); } catch (e) { hasUnzip = false; }
  if (hasUnzip) {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bundle-")), "b.zip");
    fs.writeFileSync(file, zip);
    const details = execFileSync("unzip", ["-p", file, `${order.id}-order-details.txt`]).toString();
    assert.match(details, /SHIP TO\nJane Doe\n1 Main St\nWinnipeg, MB R3C 0A1\nCA/);
    assert.match(details, /Quantity: 2\n  Material: Premium Corrugated \(corrugated plastic \/ Coroplast\)/);
    assert.match(details, /Speech bubble: "Hi!"/);
    assert.match(details, /Background: kept \(print the whole photo\)/);
    const image = execFileSync("unzip", ["-p", file, `${order.id}-item-1.jpg`]);
    assert.equal(image.subarray(0, 2).toString("hex"), "ffd8", "a real JPEG");
  }
});

test("bad order ids: malformed → 400, unknown → 404", async () => {
  assert.equal((await api("/admin/orders/nope")).status, 400);
  assert.equal((await api("/admin/orders/00000000-0000-0000-0000-000000000000")).status, 404);
});
