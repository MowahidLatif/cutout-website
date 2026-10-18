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
// production server must never run on them.
const secretsOnDevDefaults = [
  ["ADMIN_TOKEN", adminRoutes.DEV_ADMIN_TOKEN],
  ["FILE_LINK_SECRET", DEV_LINK_SECRET],
]
  .filter(([name, devValue]) => !process.env[name] || process.env[name] === devValue)
  .map(([name]) => name);
if (secretsOnDevDefaults.length > 0) {
  const message = `${secretsOnDevDefaults.join(" and ")} not set — using insecure dev defaults.`;
  if (process.env.NODE_ENV === "production") {
    throw new Error(`Refusing to start: ${message}`);
  }
  console.warn(`[warn] ${message}`);
}

const app = express();

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

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`Cutout website backend listening on port ${port}`);
});
