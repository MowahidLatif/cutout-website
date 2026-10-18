/**
 * Expiring download links for uploaded images (handed to the supplier via
 * the fulfillment email and the admin page). Anything invalid — bad key,
 * bad signature, expired — is a plain 404 so the route reveals nothing.
 */
const express = require("express");
const storage = require("../services/storage");

const router = express.Router();

router.get("/files/:key", async (req, res) => {
  const { key } = req.params;
  if (!storage.verifyDownloadSignature(key, req.query.exp, req.query.sig)) {
    return res.status(404).send("Not found");
  }
  try {
    await storage.sendFile(res, key);
  } catch (err) {
    console.error(`Failed to serve file ${key}:`, err);
    if (!res.headersSent) res.status(500).send("Something went wrong.");
  }
});

module.exports = router;
