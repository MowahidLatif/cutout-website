/**
 * The image audit: plain-JS checks on top of sharp, no external services.
 * Used by uploads.js (at upload) and storage.js (re-checked from the stored
 * file when an order is placed). See docs/backend-guide.md, "Image audit".
 *
 *  - analyzeSource: does this look like a screenshot or a web download
 *    rather than a camera original? (EXIF, shape, filename)
 *  - analyzeImage: is it blurry (sharpest regions still soft), heavily
 *    JPEG-compressed (8×8 blocking), or flat artwork (few colours)?
 *
 * All of these are heuristics. They inform the customer (and cap the print
 * score at Fair); they never block an upload or an order.
 */
const sharp = require("sharp");
const exifReader = require("exif-reader");

// ---------- Source: screenshot / web download ----------
const SCREEN_RATIOS = [
  ["16:9", 16 / 9],
  ["18:9", 2],
  ["19:9", 19 / 9],
  ["19.5:9", 19.5 / 9],
  ["20:9", 20 / 9],
  ["21:9", 21 / 9],
];
const SOCIAL_MAX_PX = 2048; // Instagram, Facebook and WhatsApp resize photos to at most this
const SCREENSHOT_NAME =
  /screen[\s_-]?shot|screenshot|whatsapp|img-\d{8}-wa\d+|received_|fb_img|snapchat|instagram/i;

/** True when the EXIF names a camera (make/model) or holds exposure settings. */
function hasCameraDetails(exifBuffer) {
  if (!exifBuffer) return false;
  try {
    const exif = exifReader(exifBuffer);
    const image = exif.Image || {};
    const photo = exif.Photo || {};
    return Boolean(image.Make || image.Model || photo.ExposureTime || photo.FNumber || photo.ISOSpeedRatings);
  } catch (err) {
    return false;
  }
}

/**
 * @param {{ filename?: string, format: string, exif?: Buffer, width: number, height: number }} input
 *   format: sharp's detected format ("jpeg", "png", "webp", "heif", "pdf"…)
 * @returns {{ isWebOrScreenshot: boolean, reasons: string[] }}
 */
function analyzeSource({ filename = "", format, exif, width, height }) {
  const reasons = [];
  // Only the iPhone camera makes HEIC (its screenshots are PNG); PDFs are documents.
  if (format === "heif" || format === "pdf") return { isWebOrScreenshot: false, reasons };

  if (SCREENSHOT_NAME.test(filename)) reasons.push("screenshot or messaging-app file name");
  if (!hasCameraDetails(exif)) {
    const ratio = Math.max(width, height) / Math.min(width, height);
    const screen = SCREEN_RATIOS.find(([, r]) => Math.abs(ratio - r) / r <= 0.02);
    const noCamera = [];
    if (screen) noCamera.push(`phone-screen shape (${screen[0]})`);
    if (format === "png") noCamera.push("PNG file");
    if (Math.max(width, height) <= SOCIAL_MAX_PX) noCamera.push(`resized to ${Math.max(width, height)} px`);
    if (noCamera.length) reasons.push("no camera details", ...noCamera);
  }
  return { isWebOrScreenshot: reasons.length > 0, reasons };
}

// ---------- Pixels: blur, compression, flat artwork ----------
const BLUR_ANALYSIS_PX = 2000; // long side the blur check works at
const TILE_PX = 128;
// Calibrated on a 1920×2880 portrait (2026-10): sharp original ≈ 1200,
// Gaussian blur σ1 ≈ 170, σ2 ≈ 16, σ4 ≈ 4. A 600 px sharp copy ≈ 400.
const BLURRY_BELOW = 60;
const COMPRESSION_CROP_PX = 1024;
// Ratio of the strongest 8-px-grid edge to the typical edge. Same portrait:
// clean or quality 75+ ≈ 1.1, quality 50 ≈ 1.6 (normal for the web, not
// flagged), quality 30 ≈ 2.3, quality 10 ≈ 4.8. Survives our re-encode and
// a 90° rotation.
const COMPRESSED_ABOVE = 2.0;
const GRAPHIC_TOP_COLOURS = 12;
const GRAPHIC_SHARE = 0.9;
// Flat artwork has crisp edges somewhere (a logo tile ≈ 600+); a heavily
// blurred photo also has few colours, but no tile gets near this.
const GRAPHIC_EDGE_MIN = 200;

/** Variance of the 3×3 Laplacian (4-neighbour) over one tile of a luma plane. */
function laplacianVariance(luma, width, x0, y0, x1, y1) {
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = Math.max(1, y0); y < y1 - 1; y++) {
    for (let x = Math.max(1, x0); x < x1 - 1; x++) {
      const i = y * width + x;
      const v = luma[i - width] + luma[i + width] + luma[i - 1] + luma[i + 1] - 4 * luma[i];
      sum += v;
      sumSq += v * v;
      n += 1;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/**
 * Sharpness of the sharpest regions: the 90th percentile of per-tile
 * Laplacian variance, over fully opaque tiles. A portrait with a soft
 * background still has a sharp face, so it isn't called blurry.
 * Returns { p90, max }, or null when there's nothing opaque to measure.
 */
function sharpnessOf(rgba, width, height) {
  const luma = new Float32Array(width * height);
  const alpha = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < luma.length; i++, p += 4) {
    luma[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
    alpha[i] = rgba[p + 3];
  }
  const scores = [];
  for (let y0 = 0; y0 < height; y0 += TILE_PX) {
    for (let x0 = 0; x0 < width; x0 += TILE_PX) {
      const x1 = Math.min(width, x0 + TILE_PX);
      const y1 = Math.min(height, y0 + TILE_PX);
      if (x1 - x0 < TILE_PX / 2 || y1 - y0 < TILE_PX / 2) continue;
      let opaque = true;
      for (let y = y0; y < y1 && opaque; y++) {
        for (let x = x0; x < x1; x++) {
          if (alpha[y * width + x] < 255) {
            opaque = false;
            break;
          }
        }
      }
      if (opaque) scores.push(laplacianVariance(luma, width, x0, y0, x1, y1));
    }
  }
  if (!scores.length) return null;
  scores.sort((a, b) => a - b);
  return { p90: scores[Math.min(scores.length - 1, Math.floor(scores.length * 0.9))], max: scores[scores.length - 1] };
}

/**
 * JPEG blocking: mean |difference| between neighbouring columns (and rows),
 * grouped by position mod 8. Compression leaves one offset (the block
 * boundary) much stronger than the rest. Taking the strongest offset copes
 * with a grid shifted by rotation. Returns ~1 for clean images.
 */
function blockinessOf(grey, width, height) {
  const ratio = (profile) => {
    const sorted = [...profile].sort((a, b) => a - b);
    const median = (sorted[3] + sorted[4]) / 2;
    if (sorted[7] < 0.5) return 1; // a flat image: nothing to measure
    // Heavy compression flattens the inside of each block (median → 0) while
    // the block edges stay: that's the strongest signal, not "no signal".
    return sorted[7] / Math.max(median, 0.5);
  };
  const cols = new Array(8).fill(0);
  const colN = new Array(8).fill(0);
  const rows = new Array(8).fill(0);
  const rowN = new Array(8).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (x < width - 1) {
        cols[x % 8] += Math.abs(grey[i + 1] - grey[i]);
        colN[x % 8] += 1;
      }
      if (y < height - 1) {
        rows[y % 8] += Math.abs(grey[i + width] - grey[i]);
        rowN[y % 8] += 1;
      }
    }
  }
  return Math.max(ratio(cols.map((s, k) => s / (colN[k] || 1))), ratio(rows.map((s, k) => s / (rowN[k] || 1))));
}

/** Share of opaque pixels covered by the most common colours (4 bits per channel). */
function topColourShare(rgba) {
  const counts = new Map();
  let opaque = 0;
  for (let p = 0; p < rgba.length; p += 4) {
    if (rgba[p + 3] < 128) continue;
    opaque += 1;
    const key = ((rgba[p] >> 4) << 8) | ((rgba[p + 1] >> 4) << 4) | (rgba[p + 2] >> 4);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  if (!opaque) return 0;
  const top = [...counts.values()].sort((a, b) => b - a).slice(0, GRAPHIC_TOP_COLOURS);
  return top.reduce((n, c) => n + c, 0) / opaque;
}

/**
 * Pixel checks on an encoded image (what we store and print).
 * @param {Buffer} buffer
 * @returns {Promise<{ sharpness: number|null, isBlurry: boolean, blockiness: number,
 *   isCompressed: boolean, colourShare: number, isFlat: boolean }>}
 */
async function analyzeImage(buffer) {
  const base = () => sharp(buffer, { limitInputPixels: 100_000_000 });
  const { width, height } = await base().metadata();

  const small = await base()
    .resize({ width: BLUR_ANALYSIS_PX, height: BLUR_ANALYSIS_PX, fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const sharpness = sharpnessOf(small.data, small.info.width, small.info.height);

  const cw = Math.min(width, COMPRESSION_CROP_PX);
  const ch = Math.min(height, COMPRESSION_CROP_PX);
  const crop = await base()
    .extract({ left: Math.floor((width - cw) / 16) * 8, top: Math.floor((height - ch) / 16) * 8, width: cw, height: ch })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const blockiness = blockinessOf(crop.data, crop.info.width, crop.info.height);

  // Nearest-neighbour: sample real pixels. Averaging would melt fine photo
  // texture into flat colour and make a photo look like artwork.
  const thumb = await base().resize({ width: 256, height: 256, fit: "inside", kernel: "nearest" }).ensureAlpha().raw().toBuffer();
  const colourShare = topColourShare(thumb);

  const isFlat = colourShare >= GRAPHIC_SHARE && sharpness !== null && sharpness.max >= GRAPHIC_EDGE_MIN;
  return {
    sharpness: sharpness === null ? null : Math.round(sharpness.p90),
    // Flat artwork has big empty areas, so "low detail" there isn't blur.
    // A perfectly uniform image (max ≈ 0) has no detail to judge either way.
    isBlurry: sharpness !== null && !isFlat && sharpness.max >= 1 && sharpness.p90 < BLURRY_BELOW,
    blockiness: Math.round(blockiness * 100) / 100,
    isCompressed: !isFlat && blockiness > COMPRESSED_ABOVE,
    colourShare: Math.round(colourShare * 1000) / 1000,
    isFlat,
  };
}

module.exports = { analyzeSource, analyzeImage, hasCameraDetails, sharpnessOf, blockinessOf, topColourShare };
