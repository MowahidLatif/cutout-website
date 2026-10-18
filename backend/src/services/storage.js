/**
 * The one place that knows where uploaded images live. STORAGE_DRIVER
 * picks "disk" (default — local dev, no AWS needed) or "s3" (production).
 * Everything else deals only in opaque image keys like "<uuid>.jpg".
 *
 * Download links are our own HMAC-signed URLs to GET /api/files/:key
 * rather than S3 presigned URLs, because S3 caps those at 7 days and the
 * supplier needs longer. In s3 mode that route redirects to a short-lived
 * S3 URL. See docs/backend-guide.md.
 */
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const DEV_LINK_SECRET = "dev-only-change-me";
const KEY_PATTERN = /^[0-9a-f-]{36}\.(jpg|png|webp)$/;

function driver() {
  return process.env.STORAGE_DRIVER || "disk";
}

function uploadDir() {
  // Relative paths resolve against backend/, not the process cwd.
  return path.resolve(__dirname, "../..", process.env.UPLOAD_DIR || "./storage/uploads");
}

function isValidKey(key) {
  return typeof key === "string" && KEY_PATTERN.test(key);
}

function assertValidKey(key) {
  if (!isValidKey(key)) {
    throw Object.assign(new Error("Invalid image key."), { code: "VALIDATION_ERROR" });
  }
}

// ---------- S3 ----------
let s3Client = null;
function getS3Client() {
  if (!s3Client) {
    s3Client = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
  }
  return s3Client;
}

function s3Bucket() {
  if (!process.env.S3_BUCKET) {
    throw new Error("S3_BUCKET is not set (required when STORAGE_DRIVER=s3).");
  }
  return process.env.S3_BUCKET;
}

function s3Key(key) {
  return `uploads/${key}`;
}

// ---------- Driver-agnostic API ----------
async function saveFile(key, buffer, contentType) {
  assertValidKey(key);
  if (driver() === "s3") {
    await getS3Client().send(
      new PutObjectCommand({ Bucket: s3Bucket(), Key: s3Key(key), Body: buffer, ContentType: contentType })
    );
    return;
  }
  await fs.mkdir(uploadDir(), { recursive: true });
  await fs.writeFile(path.join(uploadDir(), key), buffer);
}

async function fileExists(key) {
  if (!isValidKey(key)) return false;
  try {
    if (driver() === "s3") {
      await getS3Client().send(new HeadObjectCommand({ Bucket: s3Bucket(), Key: s3Key(key) }));
    } else {
      await fs.stat(path.join(uploadDir(), key));
    }
    return true;
  } catch (err) {
    if (err.code === "ENOENT" || err.name === "NotFound") return false;
    throw err;
  }
}

/** Sends the file as a download. Caller must already have checked the signature. */
async function sendFile(res, key) {
  assertValidKey(key);
  if (driver() === "s3") {
    const url = await getSignedUrl(
      getS3Client(),
      new GetObjectCommand({
        Bucket: s3Bucket(),
        Key: s3Key(key),
        ResponseContentDisposition: `attachment; filename="${key}"`,
      }),
      { expiresIn: 300 }
    );
    return res.redirect(302, url);
  }
  if (!(await fileExists(key))) {
    return res.status(404).send("Not found");
  }
  res.download(path.join(uploadDir(), key), key);
}

// ---------- Signed download links ----------
function linkSecret() {
  return process.env.FILE_LINK_SECRET || DEV_LINK_SECRET;
}

function sign(key, exp) {
  return crypto.createHmac("sha256", linkSecret()).update(`${key}.${exp}`).digest("hex");
}

/**
 * @param {string} key
 * @returns {{ url: string, expiresAt: string }}
 */
function createDownloadUrl(key) {
  assertValidKey(key);
  const ttlDays = Number(process.env.DOWNLOAD_LINK_TTL_DAYS || 30);
  const exp = Math.floor(Date.now() / 1000) + Math.round(ttlDays * 24 * 60 * 60);
  const base = (process.env.PUBLIC_API_URL || "http://localhost:4000").replace(/\/$/, "");
  return {
    url: `${base}/api/files/${key}?exp=${exp}&sig=${sign(key, exp)}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

function verifyDownloadSignature(key, exp, sig) {
  if (!isValidKey(key) || !/^\d+$/.test(exp || "") || typeof sig !== "string") return false;
  if (Number(exp) < Date.now() / 1000) return false;
  const expected = Buffer.from(sign(key, exp), "hex");
  const given = Buffer.from(sig, "hex");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

module.exports = {
  DEV_LINK_SECRET,
  isValidKey,
  saveFile,
  fileExists,
  sendFile,
  createDownloadUrl,
  verifyDownloadSignature,
};
