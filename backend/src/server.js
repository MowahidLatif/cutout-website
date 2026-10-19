require("dotenv").config();
const { createApp } = require("./app");
const { DEV_ADMIN_TOKEN } = require("./routes/admin");
const { DEV_LINK_SECRET } = require("./services/storage");

// Settings a production server must have. In development they have safe
// defaults (or are optional), so local setup needs no config — there we only
// warn. Generate secrets with `openssl rand -base64 48`.
const MIN_SECRET_LENGTH = 32;
const secretProblems = [
  ["ADMIN_TOKEN", DEV_ADMIN_TOKEN],
  ["FILE_LINK_SECRET", DEV_LINK_SECRET],
]
  .map(([name, devValue]) => {
    const value = process.env[name];
    if (!value) return `${name} is not set (using the insecure dev default)`;
    if (value === devValue) return `${name} is still the insecure dev default`;
    if (value.length < MIN_SECRET_LENGTH) {
      return `${name} is only ${value.length} characters (needs at least ${MIN_SECRET_LENGTH})`;
    }
    return null;
  })
  .filter(Boolean);

// Production-only requirements: without these the shop can't take payments,
// reach its database, get orders to the supplier, or link customers back.
const productionProblems = [];
if (!process.env.DATABASE_URL) {
  productionProblems.push("DATABASE_URL is not set");
}
if (!process.env.STRIPE_WEBHOOK_SECRET) {
  productionProblems.push("STRIPE_WEBHOOK_SECRET is not set (paid orders would never be marked paid)");
}
if (!/^\S+@\S+\.\S+$/.test(process.env.FULFILLMENT_EMAIL || "")) {
  productionProblems.push("FULFILLMENT_EMAIL is not set to an email address (paid orders would never reach the supplier)");
}
if (!/^https:\/\/\S+$/.test(process.env.SITE_URL || process.env.PUBLIC_API_URL || "")) {
  productionProblems.push("SITE_URL is not set to the site's https:// address (emails and Stripe would link to localhost)");
}

if (process.env.NODE_ENV === "production") {
  const problems = [...secretProblems, ...productionProblems];
  if (problems.length > 0) {
    throw new Error(`Refusing to start: ${problems.join("; ")}.`);
  }
} else if (secretProblems.length > 0) {
  console.warn(`[warn] ${secretProblems.join("; ")}. Generate one with: openssl rand -base64 48`);
}

// In production set HOST=127.0.0.1 so the app is only reachable through
// Caddy (which terminates HTTPS), never directly on this port.
const port = process.env.PORT || 4000;
const host = process.env.HOST || "0.0.0.0";
createApp().listen(port, host, () => {
  console.log(`Cutout website backend listening on ${host}:${port}`);
});
