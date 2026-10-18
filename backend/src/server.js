require("dotenv").config();
const express = require("express");
const cors = require("cors");

const pricingRoutes = require("./routes/pricing");
const orderRoutes = require("./routes/orders");
const adminRoutes = require("./routes/admin");
const webhookRoutes = require("./routes/webhooks");
const fileRoutes = require("./routes/files");
const { DEV_LINK_SECRET } = require("./services/storage");

// These secrets have dev defaults so local setup needs no config, but a
// production server must never run on them. Generate real ones with
// `openssl rand -base64 48`.
const MIN_SECRET_LENGTH = 32;
const secretProblems = [
  ["ADMIN_TOKEN", adminRoutes.DEV_ADMIN_TOKEN],
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
if (secretProblems.length > 0) {
  const message = secretProblems.join("; ") + ". Generate one with: openssl rand -base64 48";
  if (process.env.NODE_ENV === "production") {
    throw new Error(`Refusing to start: ${message}`);
  }
  console.warn(`[warn] ${message}`);
}

// Which proxies may tell us the client's real IP (X-Forwarded-For) and
// protocol (X-Forwarded-Proto). Default "loopback" fits Caddy on the same
// machine; anything from the open internet is never trusted, so the
// admin rate limit can't be dodged by spoofing the header.
function parseTrustProxy(value) {
  if (value === undefined || value === "") return "loopback";
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value; // e.g. "loopback", "10.0.0.0/8", "loopback, 10.0.0.1"
}

const app = express();
app.set("trust proxy", parseTrustProxy(process.env.TRUST_PROXY));

app.use(
  cors({
    origin: process.env.FRONTEND_ORIGIN || "*",
  })
);

// Stripe webhooks need the raw body for signature verification, so this
// exact path gets its own raw parser and is mounted BEFORE express.json().
// Scoping express.raw() to just this path (not all of /api) matters —
// applied more broadly it would consume the body stream for every other
// route and break express.json() below.
app.use("/api/webhooks/stripe", express.raw({ type: "application/json" }));
app.use("/api", webhookRoutes);

app.use(express.json());
app.use("/api", pricingRoutes);
app.use("/api", orderRoutes);
app.use("/api", adminRoutes);
app.use("/api", fileRoutes);

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// In production set HOST=127.0.0.1 so the API is only reachable through
// Caddy (which terminates HTTPS), never directly on this port.
const port = process.env.PORT || 4000;
const host = process.env.HOST || "0.0.0.0";
app.listen(port, host, () => {
  console.log(`Cutout website backend listening on ${host}:${port}`);
});
