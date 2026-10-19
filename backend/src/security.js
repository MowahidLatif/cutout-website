/**
 * Request-level protection: which IP a request comes from, rate limits,
 * and security headers. Mounted by app.js. See docs/backend-guide.md,
 * "Hardening".
 */
const helmet = require("helmet");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const { fail, appError } = require("./routes/_respond");

const FIFTEEN_MINUTES = 15 * 60 * 1000;

/**
 * TRUST_PROXY = how many proxies sit in front of the app (0 locally, 1
 * behind Caddy). Express then takes the client IP from that many
 * X-Forwarded-For hops; anything a client adds beyond that is ignored.
 */
function trustProxySetting(value = process.env.TRUST_PROXY) {
  if (value === undefined || value === "" || value === "false") return 0;
  if (value === "true") return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value; // also accepts Express forms like "loopback" or a subnet
}

/**
 * The client's IP. If CLIENT_IP_HEADER is set (e.g. "cf-connecting-ip" with
 * Cloudflare in front), that header is used instead — only set it when such
 * a proxy really is in front, otherwise anyone can fake it.
 */
function clientIp(req) {
  const header = process.env.CLIENT_IP_HEADER;
  if (header) {
    const value = req.get(header);
    if (value) return value.split(",")[0].trim();
  }
  return req.ip;
}

function limiter({ limit, message, ...options }) {
  return rateLimit({
    windowMs: FIFTEEN_MINUTES,
    limit,
    standardHeaders: "draft-7", // RateLimit headers; Retry-After is always sent on 429
    legacyHeaders: false,
    // IPv6 clients are grouped by /56 subnet so one machine can't rotate addresses.
    keyGenerator: (req) => ipKeyGenerator(clientIp(req)),
    // We configure trust/headers ourselves (TRUST_PROXY / CLIENT_IP_HEADER).
    validate: { xForwardedForHeader: false, trustProxy: false },
    handler: (req, res) => fail(res, appError(message, "RATE_LIMITED")),
    ...options,
  });
}

const limits = {
  // POST /api/orders and POST /api/orders/:id/checkout-session (each).
  createOrder: limiter({ limit: 10, message: "Too many orders from your connection. Please wait a few minutes and try again." }),
  checkout: limiter({ limit: 10, message: "Too many checkout attempts. Please wait a few minutes and try again." }),
  // POST /api/uploads — a 10-photo order with a few retries fits comfortably.
  upload: limiter({ limit: 20, message: "Too many uploads. Please wait a few minutes and try again." }),
  // GET /api/orders/:id (customer order lookup).
  lookup: limiter({ limit: 30, message: "Too many lookups. Please wait a few minutes and try again." }),
  // Admin: only failed sign-ins count toward 10 …
  adminAuthFailures: limiter({
    limit: 10,
    message: "Too many failed attempts. Try again later.",
    requestWasSuccessful: (req, res) => res.statusCode !== 401,
    skipSuccessfulRequests: true,
  }),
  // … and everything together toward a generous 300.
  adminAll: limiter({ limit: 300, message: "Too many requests. Try again later." }),
};

/**
 * Security headers. CSP allows our own files, Google Fonts, Stripe, and
 * data:/blob: images (photo previews). Scripts must be files — no inline
 * <script>. Inline style="" attributes are allowed (used across the pages).
 */
function securityHeaders() {
  const production = process.env.NODE_ENV === "production";
  const imgSrc = ["'self'", "data:", "blob:"];
  if (process.env.STORAGE_DRIVER === "s3" && process.env.S3_BUCKET) {
    // Image links redirect to short-lived S3 URLs on the bucket's own origin.
    imgSrc.push(`https://${process.env.S3_BUCKET}.s3.${process.env.AWS_REGION || "us-east-1"}.amazonaws.com`);
  }
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://js.stripe.com"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc,
        connectSrc: ["'self'", "https://api.stripe.com"],
        frameSrc: ["https://js.stripe.com", "https://checkout.stripe.com"],
        formAction: ["'self'", "https://checkout.stripe.com"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        // Upgrading http requests would break plain-http localhost.
        ...(production ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    strictTransportSecurity: production ? { maxAge: 31536000, includeSubDomains: true } : false,
    referrerPolicy: { policy: "no-referrer" },
    xFrameOptions: { action: "deny" },
  });
}

module.exports = { trustProxySetting, clientIp, limits, securityHeaders };
