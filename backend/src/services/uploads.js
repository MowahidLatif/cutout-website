/**
 * Validates and normalizes an uploaded image, then hands it to storage.
 * Every check here runs on the decoded file contents — the client's file
 * name and Content-Type are never trusted.
 */
const sharp = require("sharp");
const { randomUUID } = require("crypto");
const storage = require("./storage");

// Guards against decompression bombs: a small file that decodes to a huge image.
const MAX_INPUT_PIXELS = 100_000_000;

const FORMATS = {
  jpeg: { ext: "jpg", contentType: "image/jpeg", encode: (img) => img.jpeg({ quality: 95, chromaSubsampling: "4:4:4" }) },
  png: { ext: "png", contentType: "image/png", encode: (img) => img.png() },
  webp: { ext: "webp", contentType: "image/webp", encode: (img) => img.webp({ quality: 95 }) },
};

function validationError(message) {
  return Object.assign(new Error(message), { code: "VALIDATION_ERROR" });
}

function maxUploadBytes() {
  return Number(process.env.UPLOAD_MAX_MB || 25) * 1024 * 1024;
}

/**
 * @param {Buffer} buffer raw uploaded bytes
 * @returns {Promise<{ imageKey: string, width: number, height: number }>}
 */
async function processUpload(buffer) {
  let metadata;
  try {
    metadata = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  } catch (err) {
    throw validationError("That file isn't a supported image. Please upload a JPEG, PNG or WebP photo.");
  }

  const format = FORMATS[metadata.format];
  if (!format) {
    throw validationError(
      metadata.format === "heif"
        ? "HEIC photos aren't supported yet. Please export the photo as JPEG and try again."
        : `"${metadata.format}" images aren't supported. Please upload a JPEG, PNG or WebP photo.`
    );
  }

  // Dimensions as the photo will actually print, i.e. after EXIF rotation.
  const { width, height } = metadata.autoOrient;
  const minLongEdge = Number(process.env.UPLOAD_MIN_LONG_EDGE_PX || 2000);
  if (Math.max(width, height) < minLongEdge) {
    throw validationError(
      `This photo is ${width}×${height}px, which is too small to print sharply. ` +
        `Please upload one at least ${minLongEdge}px on its longest side (an original from your phone's camera works best).`
    );
  }

  // Bake the EXIF rotation into the pixels so sideways phone photos don't
  // print sideways. Re-encoding drops EXIF (incl. GPS location) but keeps
  // the colour profile.
  let output;
  try {
    output = await format
      .encode(sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS }).autoOrient().keepIccProfile())
      .toBuffer();
  } catch (err) {
    throw validationError("That image couldn't be read — it may be damaged. Please try another photo.");
  }

  const imageKey = `${randomUUID()}.${format.ext}`;
  await storage.saveFile(imageKey, output, format.contentType);
  return { imageKey, width, height };
}

module.exports = { processUpload, maxUploadBytes };
