/**
 * Presigned S3 upload URLs, so the browser can upload the image file
 * directly to S3 without routing the binary through this server.
 */
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { randomUUID } = require("crypto");

function getClient() {
  return new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
}

/**
 * @param {Object} params
 * @param {string} params.fileName
 * @param {string} params.contentType
 * @returns {Promise<{ uploadUrl: string, publicUrl: string }>}
 */
async function createPresignedUploadUrl({ fileName, contentType }) {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) {
    throw new Error("S3_BUCKET is not set.");
  }

  const safeExt = (fileName.split(".").pop() || "jpg").toLowerCase();
  const key = `uploads/${randomUUID()}.${safeExt}`;

  const client = getClient();
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
  });

  const uploadUrl = await getSignedUrl(client, command, { expiresIn: 300 });
  const region = process.env.AWS_REGION || "us-east-1";
  const publicUrl = `https://${bucket}.s3.${region}.amazonaws.com/${key}`;

  return { uploadUrl, publicUrl };
}

module.exports = { createPresignedUploadUrl };
