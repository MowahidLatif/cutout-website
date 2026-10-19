const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const sharp = require("sharp");
const { SRC, useTempUploads, makeJpeg, makePdf } = require("./helpers");

const dir = useTempUploads();
const { processUpload } = require(path.join(SRC, "services/uploads"));
const stored = async (r) => sharp(path.join(dir, r.imageKey)).metadata();

test("small photos are accepted (no minimum resolution)", async () => {
  const r = await processUpload(await makeJpeg(588, 900));
  assert.equal(r.width, 588);
  assert.equal(r.height, 900);
  assert.match(r.imageKey, /\.jpg$/);
  assert.match(r.previewUrl, /^\/api\/files\/.+\?exp=\d+&sig=[0-9a-f]+$/);
});

test("GIF, TIFF and AVIF are converted to a common print format", async () => {
  const make = (fmt, alpha) =>
    sharp({ create: { width: 300, height: 400, channels: alpha ? 4 : 3, background: alpha ? { r: 1, g: 2, b: 3, alpha: 0.5 } : "#123" } })
      [fmt]()
      .toBuffer();
  assert.equal((await stored(await processUpload(await make("tiff", false)))).format, "jpeg");
  assert.equal((await stored(await processUpload(await make("avif", false)))).format, "jpeg");
  assert.equal((await stored(await processUpload(await make("gif", true)))).format, "png"); // keeps transparency
});

test("a PDF's first page is rendered to a large image", async () => {
  const r = await processUpload(makePdf(1));
  assert.equal(Math.max(r.width, r.height), 6000);
  assert.equal((await stored(r)).format, "png");
  assert.equal(r.note, null);
});

test("a multi-page PDF prints page 1 and says so", async () => {
  const r = await processUpload(makePdf(3));
  assert.equal(r.note, "Your PDF has 3 pages — we'll print page 1.");
});

test("a damaged PDF is rejected with a clear message", async () => {
  await assert.rejects(processUpload(Buffer.from("%PDF-1.4\nnot really a pdf")), /PDF couldn't be read/);
});

test("iPhone HEIC photos are decoded", { skip: process.platform !== "darwin" && "needs macOS `sips` to make a HEIC fixture" }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heic-"));
  fs.writeFileSync(path.join(tmp, "in.jpg"), await makeJpeg(1200, 1600));
  execFileSync("sips", ["-s", "format", "heic", path.join(tmp, "in.jpg"), "--out", path.join(tmp, "in.heic")], { stdio: "ignore" });
  const r = await processUpload(fs.readFileSync(path.join(tmp, "in.heic")));
  assert.equal((await stored(r)).format, "jpeg");
  assert.deepEqual([r.width, r.height], [1200, 1600]);
});

test("SVG and non-images are rejected", async () => {
  await assert.rejects(processUpload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')), /"svg" files aren't supported/);
  await assert.rejects(processUpload(Buffer.from("just some text")), /isn't an image we can read/);
});
