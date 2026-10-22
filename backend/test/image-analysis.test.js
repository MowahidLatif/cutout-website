/** The image audit (services/imageAnalysis.js): screenshots, blur, compression, flat artwork. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");
const { SRC } = require("./helpers");

const { analyzeSource, analyzeImage } = require(path.join(SRC, "services/imageAnalysis"));

const exifOf = async (buffer) => (await sharp(buffer).metadata()).exif;

/** A detailed "photo": smooth gradients plus fine texture (random noise, fixed seed). */
async function photo(width = 1600, height = 1200) {
  const noise = Buffer.alloc(width * height * 3);
  let seed = 7;
  for (let i = 0; i < noise.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    noise[i] = 60 + ((i / 3) % width) / (width / 120) + (seed % 70);
  }
  return sharp(noise, { raw: { width, height, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
}

const logoSvg = (w = 1200, h = 800) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#fff"/>` +
      `<circle cx="${w * 0.3}" cy="${h / 2}" r="${h * 0.3}" fill="#d9572b"/><rect x="${w * 0.6}" y="${h * 0.3}" width="${w * 0.3}" height="${h * 0.4}" fill="#1e5aa8"/></svg>`
  );

test("a phone screenshot (PNG, 19.5:9, no camera details) is flagged", () => {
  const r = analyzeSource({ format: "png", width: 1170, height: 2532, exif: undefined });
  assert.equal(r.isWebOrScreenshot, true);
  assert.ok(r.reasons.includes("phone-screen shape (19.5:9)"), r.reasons.join());
});

test("a camera original with Make/Model EXIF is not flagged", async () => {
  const buffer = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#888" } })
    .jpeg()
    .withExif({ IFD0: { Make: "Apple", Model: "iPhone 15" } })
    .toBuffer();
  const r = analyzeSource({ format: "jpeg", width: 4032, height: 3024, exif: await exifOf(buffer) });
  assert.deepEqual(r, { isWebOrScreenshot: false, reasons: [] });
});

test("screenshot / messaging-app file names are flagged even with camera details", async () => {
  const buffer = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#888" } })
    .jpeg()
    .withExif({ IFD0: { Make: "Apple", Model: "iPhone 15" } })
    .toBuffer();
  for (const filename of ["Screenshot 2026-10-21 at 10.02.11.jpg", "Screen_Shot.png", "IMG-20260101-WA0007.jpg"]) {
    assert.equal(analyzeSource({ filename, format: "jpeg", width: 4032, height: 3024, exif: await exifOf(buffer) }).isWebOrScreenshot, true, filename);
  }
});

test("a social-media sized JPEG without camera details is flagged; a large one isn't; HEIC never is", () => {
  assert.equal(analyzeSource({ format: "jpeg", width: 1080, height: 1350 }).isWebOrScreenshot, true);
  assert.equal(analyzeSource({ format: "jpeg", width: 4000, height: 3000 }).isWebOrScreenshot, false);
  assert.equal(analyzeSource({ format: "heif", width: 1170, height: 2532, filename: "x.heic" }).isWebOrScreenshot, false);
});

test("a detailed photo is sharp; the same photo blurred is blurry", async () => {
  const sharpPhoto = await photo();
  const a = await analyzeImage(sharpPhoto);
  assert.equal(a.isBlurry, false, `sharpness ${a.sharpness}`);
  const blurred = await sharp(sharpPhoto).blur(4).jpeg({ quality: 95 }).toBuffer();
  const b = await analyzeImage(blurred);
  assert.equal(b.isBlurry, true, `sharpness ${b.sharpness}`);
});

test("a sharp subject on a blurred background is not called blurry (sharpest regions count)", async () => {
  const background = await sharp(await photo(1600, 1200)).blur(10).toBuffer();
  const subject = await sharp(await photo(500, 700)).toBuffer();
  const portrait = await sharp(background).composite([{ input: subject, left: 550, top: 250 }]).jpeg({ quality: 95 }).toBuffer();
  const a = await analyzeImage(portrait);
  assert.equal(a.isBlurry, false, `sharpness ${a.sharpness}`);
});

test("heavy JPEG compression is detected; normal quality isn't", async () => {
  const source = await sharp(await photo()).blur(1.2).toBuffer(); // photo-like: smooth with detail
  const heavy = await analyzeImage(await sharp(source).jpeg({ quality: 8 }).toBuffer());
  const fine = await analyzeImage(await sharp(source).jpeg({ quality: 95 }).toBuffer());
  assert.equal(heavy.isCompressed, true, `blockiness ${heavy.blockiness}`);
  assert.equal(fine.isCompressed, false, `blockiness ${fine.blockiness}`);
});

test("flat artwork is recognised; a photo isn't", async () => {
  assert.equal((await analyzeImage(await sharp(logoSvg()).png().toBuffer())).isFlat, true);
  assert.equal((await analyzeImage(await photo())).isFlat, false);
});

// The real portrait used to calibrate the thresholds, when it's available locally.
const PORTRAIT = process.env.AUDIT_SAMPLE_PHOTO;
test("the calibration portrait passes every check", { skip: !(PORTRAIT && fs.existsSync(PORTRAIT)) && "set AUDIT_SAMPLE_PHOTO to run" }, async () => {
  const a = await analyzeImage(fs.readFileSync(PORTRAIT));
  assert.deepEqual([a.isBlurry, a.isCompressed, a.isFlat], [false, false, false]);
});

module.exports = { logoSvg, photo };
