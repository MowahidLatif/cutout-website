/**
 * Every setting the backend reads from the environment, in one place.
 * Nothing else in src/ reads process.env. Values come from backend/.env
 * (loaded by server.js; see .env.example for what each one is) and are
 * read when used, not at startup, so tests can change them between cases.
 *
 * Secrets live only in the environment. The dev fallbacks below are
 * public and deliberately weak: production refuses to start with them
 * (startupProblems, called by server.js).
 */
const DEV_ADMIN_TOKEN = "dev-admin-token";
const DEV_LINK_SECRET = "dev-only-change-me";
const MIN_SECRET_LENGTH = 32;

const env = (name) => process.env[name] || "";

const config = {
  get production() { return process.env.NODE_ENV === "production"; },

  // ---------- Server ----------
  get port() { return process.env.PORT || 4000; },
  // Production: 127.0.0.1, so the app is only reachable through Caddy.
  get host() { return process.env.HOST || "0.0.0.0"; },
  // Proxies in front (0 locally, 1 behind Caddy); see security.js.
  get trustProxy() { return process.env.TRUST_PROXY; },
  // Only if Cloudflare (or similar) is in front, e.g. "cf-connecting-ip".
  get clientIpHeader() { return env("CLIENT_IP_HEADER"); },
  // Only if the frontend is ever hosted on another origin (enables CORS).
  get frontendOrigin() { return env("FRONTEND_ORIGIN"); },
  // The site's public address, used for every link we hand out. The site
  // and API share it. PUBLIC_API_URL is its old name and still works.
  get siteUrl() {
    return (process.env.SITE_URL || process.env.PUBLIC_API_URL || "http://localhost:4000").replace(/\/+$/, "");
  },

  // ---------- Database ----------
  get databaseUrl() { return process.env.DATABASE_URL; },

  // ---------- Stripe ----------
  get stripeSecretKey() { return env("STRIPE_SECRET_KEY"); },
  get stripeWebhookSecret() { return process.env.STRIPE_WEBHOOK_SECRET; },
  // Where Stripe sends the customer back: pages on the site unless overridden.
  get stripeSuccessUrl() { return process.env.STRIPE_SUCCESS_URL || `${config.siteUrl}/order-status?order={ORDER_ID}`; },
  get stripeCancelUrl() { return process.env.STRIPE_CANCEL_URL || `${config.siteUrl}/checkout`; },

  // ---------- AWS (S3 + SES) ----------
  get awsRegion() { return process.env.AWS_REGION || "us-east-1"; },
  // SES is used only when all three are set; otherwise emails are logged.
  get sesConfigured() { return Boolean(env("AWS_ACCESS_KEY_ID") && env("AWS_SECRET_ACCESS_KEY") && env("SES_FROM_EMAIL")); },
  get sesFromEmail() { return env("SES_FROM_EMAIL"); },
  // Where paid orders go (forwarded to the supplier). Required in production.
  get fulfillmentEmail() { return env("FULFILLMENT_EMAIL"); },

  // ---------- Uploaded images ----------
  get storageDriver() { return process.env.STORAGE_DRIVER || "disk"; },
  get s3Bucket() { return env("S3_BUCKET"); },
  // Relative paths resolve against backend/ (storage.js).
  get uploadDir() { return process.env.UPLOAD_DIR || "./storage/uploads"; },
  // The most a file can be and still go by email (see .env.example).
  get uploadMaxMb() { return Number(process.env.UPLOAD_MAX_MB || 18); },
  get fileLinkSecret() { return process.env.FILE_LINK_SECRET || DEV_LINK_SECRET; },
  get downloadLinkTtlDays() { return Number(process.env.DOWNLOAD_LINK_TTL_DAYS || 30); },

  // ---------- Admin ----------
  get adminToken() { return process.env.ADMIN_TOKEN || DEV_ADMIN_TOKEN; },

  /**
   * What's wrong with the configuration, for server.js. `secrets` problems
   * are warnings in development; in production every problem is fatal.
   * Generate secrets with `openssl rand -base64 48`.
   */
  startupProblems() {
    const secrets = [
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

    // Without these the shop can't take payments, reach its database, get
    // orders to the supplier, or link customers back.
    const production = [];
    if (!config.databaseUrl) {
      production.push("DATABASE_URL is not set");
    }
    if (!config.stripeWebhookSecret) {
      production.push("STRIPE_WEBHOOK_SECRET is not set (paid orders would never be marked paid)");
    }
    if (!/^\S+@\S+\.\S+$/.test(config.fulfillmentEmail)) {
      production.push("FULFILLMENT_EMAIL is not set to an email address (paid orders would never reach the supplier)");
    }
    if (!/^https:\/\/\S+$/.test(process.env.SITE_URL || process.env.PUBLIC_API_URL || "")) {
      production.push("SITE_URL is not set to the site's https:// address (emails and Stripe would link to localhost)");
    }
    return { secrets, production };
  },
};

module.exports = config;
