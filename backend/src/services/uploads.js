/**
 * Normalizes an uploaded photo (or PDF) into a print-ready image and hands it
 * to storage. Every decision is made from the decoded file contents — the
 * client's file name and Content-Type are never trusted.
 *
 * There's no minimum resolution: any size is accepted, and the studio shows
 * how sharply it will print (printQuality in services/pricing.js). Low
 * quality needs the customer's confirmation when ordering.
 *
 *   JPEG / PNG / WebP     → kept in their format (EXIF rotation baked in)
 *   GIF / TIFF / AVIF     → JPEG, or PNG if the image has transparency
 *   HEIC (iPhone)         → JPEG (decoded by libheif, compiled to WebAssembly)
 *   PDF                   → page 1 rendered to PNG (~6000 px on the long side)
 *   SVG and anything else → rejected
 */
const path = require("path");
const sharp = require("sharp");
const { randomUUID } = require("crypto");
const storage = require("./storage");

// Guards against decompression bombs: a small file that decodes to a huge image.
const MAX_INPUT_PIXELS = 100_000_000;
// PDFs are vector or embedded images; render page 1 this big on its long side.
const PDF_RENDER_LONG_EDGE = 6000;
// The studio shows the processed image via a short-lived signed link.
const PREVIEW_TTL_SECONDS = 24 * 60 * 60;

const OUTPUTS = {
  jpeg: { ext: "jpg", contentType: "image/jpeg", encode: (img) => img.jpeg({ quality: 95, chromaSubsampling: "4:4:4" }) },
  png: { ext: "png", contentType: "image/png", encode: (img) => img.png() },
  webp: { ext: "webp", contentType: "image/webp", encode: (img) => img.webp({ quality: 95 }) },
};

// Formats sharp decodes that we convert to a common print format.
const CONVERTED_FORMATS = ["gif", "tiff", "heif"]; // sharp reports AVIF as "heif"

function validationError(message) {
  return Object.assign(new Error(message), { code: "VALIDATION_ERROR" });
}

function maxUploadBytes() {
  return Number(process.env.UPLOAD_MAX_MB || 25) * 1024 * 1024;
}

function isPdf(buffer) {
  return buffer.subarray(0, 5).toString("latin1") === "%PDF-";
}

/** HEIC/HEIF photos (HEVC-coded — what iPhones produce). AVIF is handled by sharp. */
function isHeic(buffer) {
  if (buffer.subarray(4, 8).toString("latin1") !== "ftyp") return false;
  const brand = buffer.subarray(8, 12).toString("latin1");
  return ["heic", "heix", "hevc", "hevx", "heim", "heis"].includes(brand);
}

/** Renders page 1 of a PDF to a PNG buffer. */
async function renderPdfFirstPage(buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { createCanvas } = require("@napi-rs/canvas");
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false, // never compile code from the PDF
    useSystemFonts: false,
    standardFontDataUrl: path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts") + path.sep,
    verbosity: 0,
  });
  let doc;
  try {
    doc = await loadingTask.promise;
  } catch (err) {
    await loadingTask.destroy();
    if (err && err.name === "PasswordException") {
      throw validationError("That PDF is password-protected. Please upload an unlocked PDF or an image.");
    }
    throw validationError("That PDF couldn't be read — it may be damaged. Please try another file.");
  }
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(PDF_RENDER_LONG_EDGE / Math.max(base.width, base.height), 50);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff"; // PDFs assume a white page
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, canvas, viewport }).promise;
    return { png: canvas.toBuffer("image/png"), pages: doc.numPages };
  } catch (err) {
    throw validationError("That PDF couldn't be rendered. Please try exporting it as an image.");
  } finally {
    await loadingTask.destroy();
  }
}

/** Decodes a HEIC photo to raw RGBA, as a sharp input. */
async function decodeHeic(buffer) {
  const decode = require("heic-decode");
  try {
    const { width, height, data } = await decode({ buffer });
    if (width * height > MAX_INPUT_PIXELS) throw validationError("That photo is too large to process.");
    return sharp(Buffer.from(data), { raw: { width, height, channels: 4 }, limitInputPixels: MAX_INPUT_PIXELS });
  } catch (err) {
    if (err.code === "VALIDATION_ERROR") throw err;
    throw validationError("That HEIC photo couldn't be read. Please try exporting it as JPEG.");
  }
}

/**
 * @param {Buffer} buffer raw uploaded bytes
 * @returns {Promise<{ imageKey: string, width: number, height: number, previewUrl: string, note: string|null }>}
 */
async function processUpload(buffer) {
  let image; // a sharp pipeline, already oriented
  let output; // one of OUTPUTS
  let note = null;

  if (isPdf(buffer)) {
    const { png, pages } = await renderPdfFirstPage(buffer);
    image = sharp(png, { limitInputPixels: MAX_INPUT_PIXELS });
    output = OUTPUTS.png;
    if (pages > 1) note = `Your PDF has ${pages} pages — we'll print page 1.`;
  } else if (isHeic(buffer)) {
    image = await decodeHeic(buffer);
    output = OUTPUTS.jpeg;
  } else {
    let metadata;
    try {
      metadata = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    } catch (err) {
      throw validationError("That file isn't an image we can read. Please upload a photo (JPEG, PNG, HEIC, WebP…) or a PDF.");
    }
    if (OUTPUTS[metadata.format]) {
      output = OUTPUTS[metadata.format];
    } else if (CONVERTED_FORMATS.includes(metadata.format)) {
      output = metadata.hasAlpha ? OUTPUTS.png : OUTPUTS.jpeg;
    } else {
      throw validationError(`"${metadata.format}" files aren't supported. Please upload a photo (JPEG, PNG, HEIC, WebP…) or a PDF.`);
    }
    // Bake EXIF rotation into the pixels so sideways phone photos don't print
    // sideways; re-encoding drops EXIF (incl. GPS) but keeps the colour profile.
    image = sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS }).autoOrient().keepIccProfile();
  }

  let result;
  try {
    result = await output.encode(image).toBuffer({ resolveWithObject: true });
  } catch (err) {
    if (err.code === "VALIDATION_ERROR") throw err;
    throw validationError("That image couldn't be read — it may be damaged. Please try another file.");
  }

  const imageKey = `${randomUUID()}.${output.ext}`;
  await storage.saveFile(imageKey, result.data, output.contentType);
  return {
    imageKey,
    width: result.info.width,
    height: result.info.height,
    previewUrl: storage.createDownloadUrl(imageKey, { ttlSeconds: PREVIEW_TTL_SECONDS, relative: true }).url,
    note,
  };
}

module.exports = { processUpload, maxUploadBytes };
