/**
 * Builds the Express app: API routes under /api, the static site, and the
 * protection around them. No listening and no startup checks here — that's
 * server.js — so tests can run the real app on a throwaway port.
 */
const path = require("path");
const express = require("express");
const cors = require("cors");
const { fail, appError } = require("./routes/_respond");
const { trustProxySetting, limits, securityHeaders } = require("./security");

const pricingRoutes = require("./routes/pricing");
const orderRoutes = require("./routes/orders");
const adminRoutes = require("./routes/admin");
const webhookRoutes = require("./routes/webhooks");
const fileRoutes = require("./routes/files");

function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", trustProxySetting());
  app.use(securityHeaders());

  // The site is served by this same app (below), so the browser calls the
  // API on the same origin and no CORS is needed. Only if you deliberately
  // host the frontend somewhere else, set FRONTEND_ORIGIN to allow it.
  if (process.env.FRONTEND_ORIGIN) {
    app.use(cors({ origin: process.env.FRONTEND_ORIGIN }));
  }

  // Stripe webhooks need the raw body for signature verification, so this
  // exact path gets its own raw parser and is mounted BEFORE express.json().
  // It's exempt from rate limits (Stripe retries on its own schedule).
  app.use("/api/webhooks/stripe", express.raw({ type: "application/json" }));
  app.use("/api", webhookRoutes);

  app.get("/health", (req, res) => {
    res.json({ status: "ok" });
  });

  app.use(express.json({ limit: "100kb" }));

  // Rate limits (per client IP, 15-minute windows).
  app.post("/api/orders", limits.createOrder);
  app.post("/api/orders/:id/checkout-session", limits.checkout);
  app.post("/api/uploads", limits.upload);
  app.get("/api/orders/:id", limits.lookup);
  app.use("/api/admin", limits.adminAll, limits.adminAuthFailures);

  app.use("/api", pricingRoutes);
  app.use("/api", orderRoutes);
  app.use("/api", adminRoutes);
  app.use("/api", fileRoutes);

  // Unknown API paths get a JSON 404 rather than falling through to the site.
  app.use("/api", (req, res) => {
    fail(res, appError(`No API route for ${req.method} ${req.originalUrl}.`, "NOT_FOUND"));
  });

  // The static site (frontend/), on the same origin as the API. `extensions`
  // gives clean URLs: /pricing serves pricing.html (the .html URLs still work).
  const FRONTEND_DIR = path.resolve(__dirname, "../../frontend");
  app.use(express.static(FRONTEND_DIR, { extensions: ["html"] }));

  // Browsers ask for /favicon.ico on pages without an icon tag.
  app.get("/favicon.ico", (req, res) => res.redirect(301, "/favicon.svg"));

  app.use((req, res) => {
    res.status(404).type("text/plain").send("Not found");
  });

  // Last stop for anything thrown or passed to next(err): JSON for the API,
  // never a stack trace (fail() hides internal messages in production).
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === "entity.too.large") {
      return fail(res, appError("That request is too large.", "PAYLOAD_TOO_LARGE"));
    }
    if (err.type === "entity.parse.failed") {
      return fail(res, appError("The request body isn't valid JSON.", "VALIDATION_ERROR"));
    }
    if (res.headersSent) return next(err);
    fail(res, err);
  });

  return app;
}

module.exports = { createApp };
