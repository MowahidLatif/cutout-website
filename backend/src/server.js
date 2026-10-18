require("dotenv").config();
const express = require("express");
const cors = require("cors");

const pricingRoutes = require("./routes/pricing");
const orderRoutes = require("./routes/orders");
const adminRoutes = require("./routes/admin");
const webhookRoutes = require("./routes/webhooks");

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

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`Cutout website backend listening on port ${port}`);
});
