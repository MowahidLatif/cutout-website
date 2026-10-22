/** Logo vectorization and the audit end to end: upload → vectorize → order → supplier files. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { useTestDb, useTempUploads, captureEmails, startApp, orderInput, SRC } = require("./helpers");

const TOKEN = "v".repeat(40);
let db, app, dir, emails, orders, email;

const svgLogo = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><rect width="1600" height="1000" fill="#fff"/>` +
    `<circle cx="450" cy="500" r="300" fill="#d9572b"/><circle cx="450" cy="500" r="120" fill="#fff"/>` +
    `<rect x="900" y="300" width="500" height="400" fill="#1e5aa8"/></svg>`
);

test.before(async () => {
  process.env.ADMIN_TOKEN = TOKEN;
  process.env.FULFILLMENT_EMAIL = "orders@shop.example.com";
  db = await useTestDb();
  dir = useTempUploads();
  emails = captureEmails();
  app = await startApp();
  orders = require(path.join(SRC, "services/orders"));
  email = require(path.join(SRC, "services/email"));
});
test.after(async () => {
  await app.close();
  await db.close();
});

async function upload(buffer, filename, fields = {}) {
  const form = new FormData();
  form.append("image", new Blob([buffer]), filename);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = await fetch(`${app.url}/api/uploads`, { method: "POST", body: form });
  return { status: res.status, body: await res.json() };
}

test("uploads report the audit; a flat logo looks like a graphic, not a screenshot", async () => {
  const { status, body } = await upload(await sharp(svgLogo).jpeg({ quality: 90 }).toBuffer(), "logo.jpg");
  assert.equal(status, 201);
  assert.equal(body.data.audit.looksLikeGraphic, true);
  assert.equal(body.data.audit.isWebOrScreenshot, false);
});

test("a screenshot is flagged, but not when the studio marks its own cutout", async () => {
  // A screenshot of a photo: phone-screen shape, PNG, mostly photo content.
  const shot = await sharp({ create: { width: 1170, height: 2532, channels: 3, noise: { type: "gaussian", mean: 128, sigma: 50 } } })
    .png()
    .toBuffer();
  assert.equal((await upload(shot, "IMG_1234.png")).body.data.audit.isWebOrScreenshot, true);
  const own = (await upload(shot, "cutout.png", { kind: "cutout" })).body.data.audit;
  assert.equal(own.isWebOrScreenshot, false);
  assert.equal(own.looksLikeGraphic, false);
});

test("vectorize: SVG preview + vector PDF + transparent PNG; the order scores 100 and the supplier gets PDF + PNG", async () => {
  const up = (await upload(await sharp(svgLogo).png().toBuffer(), "logo.png")).body.data;
  const res = await fetch(`${app.url}/api/uploads/${up.imageKey}/vectorize`, { method: "POST" });
  assert.equal(res.status, 201);
  const vec = (await res.json()).data;
  assert.match(vec.imageKey, /^[0-9a-f-]{36}\.svg$/);
  assert.equal(vec.vector, true);
  const base = vec.imageKey.replace(/\.svg$/, "");
  const svg = fs.readFileSync(path.join(dir, `${base}.svg`), "utf8");
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.doesNotMatch(svg, /<script|on\w+=/i, "paths only");
  assert.equal(fs.readFileSync(path.join(dir, `${base}.pdf`)).subarray(0, 5).toString(), "%PDF-");
  const png = sharp(path.join(dir, `${base}.png`));
  assert.equal((await png.stats()).isOpaque, false, "background removed");
  assert.equal(Math.max((await png.metadata()).width, (await png.metadata()).height), 4000);

  // The preview link serves the SVG sandboxed.
  const preview = await fetch(`${app.url}${vec.previewUrl}`);
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get("content-security-policy"), /sandbox/);

  const order = await orders.createOrder(orderInput([{ material: "coroplast", heightIn: 72, quantity: 1, imageKey: vec.imageKey }]));
  const item = order.items[0];
  assert.deepEqual([item.isVector, item.printScore, item.printPpi, item.hasTransparency], [true, 100, null, true]);
  const { body } = email.buildFulfillmentEmail(order);
  assert.match(body, /Print quality: Great — vector graphic/);
  assert.match(body, new RegExp(`Print file \\(vector PDF\\) \\(link expires [\\d-]+\\): \\S+${base}\\.pdf`));
  assert.match(body, new RegExp(`PNG fallback \\(link expires [\\d-]+\\): \\S+${base}\\.png`));

  // Admin: both links, and the bundle carries both files.
  const auth = { headers: { Authorization: `Bearer ${TOKEN}` } };
  const detail = (await (await fetch(`${app.url}/api/admin/orders/${order.id}`, auth)).json()).data;
  assert.deepEqual(detail.items[0].downloadFiles.map((f) => f.label), ["Print file (vector PDF)", "PNG fallback"]);
  const zip = Buffer.from(await (await fetch(`${app.url}/api/admin/orders/${order.id}/bundle`, auth)).arrayBuffer());
  assert.ok(zip.includes(`${order.id}-item-1.pdf`) && zip.includes(`${order.id}-item-1.png`));
});

test("vectorize refuses unknown keys and SVG/PDF keys", async () => {
  for (const key of ["00000000-0000-0000-0000-000000000000.png", "00000000-0000-0000-0000-000000000000.svg", "nope"]) {
    assert.equal((await fetch(`${app.url}/api/uploads/${key}/vectorize`, { method: "POST" })).status, 400, key);
  }
});

test("a blurry photo is re-checked at order time: is_blurry and a score capped at 59", async () => {
  const blurry = await sharp({ create: { width: 3000, height: 4000, channels: 3, noise: { type: "gaussian", mean: 128, sigma: 60 } } })
    .blur(8)
    .jpeg({ quality: 95 })
    .toBuffer();
  const up = (await upload(blurry, "IMG_0001.jpg")).body.data;
  assert.equal(up.audit.isBlurry, true, `sharpness ${up.audit.sharpness}`);
  const order = await orders.createOrder(orderInput([{ material: "coroplast", heightIn: 36, quantity: 1, imageKey: up.imageKey }]));
  assert.deepEqual([order.items[0].isBlurry, order.items[0].printScore], [true, 59]);
  assert.match(email.buildFulfillmentEmail(order).body, /⚠ Photo looks blurry or out of focus/);
});
