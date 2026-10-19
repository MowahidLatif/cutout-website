const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const sharp = require("sharp");
const { SRC, useTempUploads, makeJpeg, makePdf, makeCutoutPng } = require("./helpers");

const dir = useTempUploads();
const { processUpload } = require(path.join(SRC, "services/uploads"));
const stored = async (r) => sharp(path.join(dir, r.imageKey)).metadata();

test("small photos are accepted (no minimum resolution)", async () => {
  const r = await processUpload(await makeJpeg(588, 900));
  assert.deepEqual([r.width, r.height], [588, 900]);
  assert.match(r.imageKey, /\.jpg$/);
  assert.match(r.previewUrl, /^\/api\/files\/.+\?exp=\d+&sig=[0-9a-f]+$/);
});

test("PNG and WebP keep their format", async () => {
  const make = (fmt) => sharp({ create: { width: 300, height: 400, channels: 3, background: "#123" } })[fmt]().toBuffer();
  assert.equal((await stored(await processUpload(await make("png")))).format, "png");
  assert.equal((await stored(await processUpload(await make("webp")))).format, "webp");
});

test("GIF, TIFF, AVIF, SVG and non-images are refused as unsupported (415)", async () => {
  const make = (fmt) => sharp({ create: { width: 300, height: 400, channels: 3, background: "#123" } })[fmt]().toBuffer();
  for (const fmt of ["gif", "tiff", "avif"]) {
    await assert.rejects(processUpload(await make(fmt)), (err) => err.code === "UNSUPPORTED_MEDIA_TYPE" && /aren't supported/.test(err.message));
  }
  await assert.rejects(processUpload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')), { code: "UNSUPPORTED_MEDIA_TYPE" });
  await assert.rejects(processUpload(Buffer.from("just some text")), { code: "UNSUPPORTED_MEDIA_TYPE" });
});

test("a PDF's first page is rendered to a large image", async () => {
  const r = await processUpload(makePdf(1));
  assert.equal(Math.max(r.width, r.height), 6000);
  assert.equal(r.note, null);
});

test("a multi-page PDF prints page 1 and says so", async () => {
  assert.equal((await processUpload(makePdf(3))).note, "Your PDF has 3 pages — we'll print page 1.");
});

test("a damaged PDF is rejected with a clear message", async () => {
  await assert.rejects(processUpload(Buffer.from("%PDF-1.4\nnot really a pdf")), /PDF couldn't be read/);
});

test("the stored print file is kept small enough to email", async () => {
  process.env.UPLOAD_MAX_MB = "0.5"; // force the shrink path with a noisy (hard to compress) PNG
  try {
    const noise = require("crypto").randomBytes(1500 * 1500 * 3); // incompressible
    const png = await sharp(noise, { raw: { width: 1500, height: 1500, channels: 3 } }).png().toBuffer();
    const r = await processUpload(png);
    assert.ok(fs.statSync(path.join(dir, r.imageKey)).size <= 0.5 * 1024 * 1024);
    assert.match(r.imageKey, /\.jpg$/);
  } finally {
    delete process.env.UPLOAD_MAX_MB;
  }
});

test("a background-removed cutout stays a transparent PNG", async () => {
  const r = await processUpload(await makeCutoutPng(400, 600));
  assert.match(r.imageKey, /\.png$/);
  const meta = await stored(r);
  assert.equal(meta.hasAlpha, true);
  assert.equal((await sharp(path.join(dir, r.imageKey)).stats()).isOpaque, false);
});

test("a cutout too big to email is scaled down but keeps its transparency", async () => {
  process.env.UPLOAD_MAX_MB = "0.5";
  try {
    const r = await processUpload(await makeCutoutPng(1200, 1200, { noise: true }));
    assert.match(r.imageKey, /\.png$/, "not flattened to JPEG");
    assert.ok(fs.statSync(path.join(dir, r.imageKey)).size <= 0.5 * 1024 * 1024);
    assert.ok(r.width < 1200, "scaled down");
    const image = sharp(path.join(dir, r.imageKey));
    const { data } = await image.clone().extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
    assert.equal(data[3], 0, "corner still transparent");
  } finally {
    delete process.env.UPLOAD_MAX_MB;
  }
});

test("iPhone HEIC photos are decoded", { skip: process.platform !== "darwin" && "needs macOS `sips` to make a HEIC fixture" }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heic-"));
  fs.writeFileSync(path.join(tmp, "in.jpg"), await makeJpeg(1200, 1600));
  execFileSync("sips", ["-s", "format", "heic", path.join(tmp, "in.jpg"), "--out", path.join(tmp, "in.heic")], { stdio: "ignore" });
  const r = await processUpload(fs.readFileSync(path.join(tmp, "in.heic")));
  assert.equal((await stored(r)).format, "jpeg");
  assert.deepEqual([r.width, r.height], [1200, 1600]);
});
