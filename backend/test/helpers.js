/**
 * Shared test setup. Tests run with Node's built-in runner (`npm test`), one
 * file at a time, and never touch your dev database:
 *
 *  - TEST_DATABASE_URL (env, or backend/.env.test) → a separate, real
 *    Postgres database. It's migrated at the start of each file and wiped
 *    between tests. Refused if it equals DATABASE_URL or its name doesn't
 *    end in "_test".
 *  - otherwise → an in-process Postgres (PGlite), fresh per file.
 *
 * Stripe and email are stubbed: no network. Call useTestDb() at the top of a
 * file BEFORE requiring anything from src/.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

require("dotenv").config({ path: path.join(__dirname, "..", ".env.test"), quiet: true });

const SRC = path.join(__dirname, "..", "src");
const FRONTEND = path.join(__dirname, "..", "..", "frontend");
// Everything an order touches; pricing/shipping config tables are kept.
const ORDER_TABLES = ["order_notes", "order_status_events", "payments", "order_items", "orders"];

function injectPool(pool) {
  const poolPath = require.resolve(path.join(SRC, "db", "pool.js"));
  require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: pool };
}

function migrationFiles() {
  const dir = path.join(SRC, "db", "migrations");
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8"));
}

/**
 * Gives src/db/pool.js a test database with every migration applied.
 * Returns { query, reset, close, kind }.
 */
async function useTestDb() {
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    const name = new URL(url).pathname.slice(1);
    if (url === process.env.DATABASE_URL || !name.endsWith("_test")) {
      throw new Error(
        `Refusing to run tests against "${name}": TEST_DATABASE_URL must be a separate database whose name ends in "_test".`
      );
    }
    const { Pool } = require("pg");
    const pool = new Pool({ connectionString: url, max: 5 });
    for (const sql of migrationFiles()) await pool.query(sql);
    injectPool(pool);
    const reset = () => pool.query(`TRUNCATE ${ORDER_TABLES.join(", ")} RESTART IDENTITY CASCADE`);
    await reset();
    return { kind: "postgres", query: (q, p) => pool.query(q, p), reset, close: () => pool.end() };
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const { pgcrypto } = await import("@electric-sql/pglite/contrib/pgcrypto");
  const db = await PGlite.create({ extensions: { pgcrypto } });
  // pg reports rowCount; PGlite reports affectedRows (and nothing for SELECTs).
  const query = async (sql, params) => {
    const r = await db.query(sql, params);
    return { ...r, rowCount: r.affectedRows || r.rows.length };
  };
  for (const sql of migrationFiles()) await db.exec(sql);
  injectPool({ query, connect: async () => ({ query, release() {} }), end: async () => {} });
  const reset = () => db.exec(`TRUNCATE ${ORDER_TABLES.join(", ")} CASCADE`);
  return { kind: "pglite", query, reset, close: () => db.close() };
}

/** Points the disk storage driver at a fresh temp folder. */
function useTempUploads() {
  process.env.STORAGE_DRIVER = "disk";
  process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cutout-test-uploads-"));
  return process.env.UPLOAD_DIR;
}

/**
 * Stubs Stripe's Checkout Session creation (no network) but keeps the real
 * SDK otherwise — so webhook signatures are generated and verified for real.
 * Returns { params } (the last session sent) and `sign(payload)` for webhooks.
 */
function stubStripe() {
  const sent = { params: null };
  process.env.STRIPE_SECRET_KEY = "sk_test_stub";
  process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "whsec_test_secret";
  const stripePath = require.resolve("stripe");
  const RealStripe = require("stripe");
  function StubStripe(key, options) {
    const client = new RealStripe(key, options);
    client.checkout.sessions.create = async (params) => {
      sent.params = params;
      return { id: "cs_test_stub", url: "https://checkout.stripe.test/session" };
    };
    return client;
  }
  require.cache[stripePath] = { id: stripePath, filename: stripePath, loaded: true, exports: StubStripe };
  const signer = new RealStripe("sk_test_stub");
  sent.sign = (payload) =>
    signer.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
  return sent;
}

/**
 * Captures emails instead of printing them (dev mode logs "[email:dev]").
 * Returns an array that fills with { to, subject, body }.
 */
function captureEmails() {
  const emails = [];
  const original = console.log;
  console.log = (...args) => {
    const text = args.join(" ");
    const match = /^\[email:dev\] To: (.*)\nSubject: (.*)\n\n([\s\S]*)$/.exec(text);
    if (match) emails.push({ to: match[1], subject: match[2], body: match[3] });
    else if (!/^\[admin\]/.test(text)) original(...args);
  };
  return emails;
}

/** Starts the real app on a throwaway port. Returns { url, close }. */
async function startApp() {
  const { createApp } = require(path.join(SRC, "app"));
  const server = createApp().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Runs a frontend script (no DOM needed) and returns its `window`. */
function loadFrontend(...files) {
  const context = { window: {} };
  vm.createContext(context);
  for (const file of files) {
    vm.runInContext(fs.readFileSync(path.join(FRONTEND, file), "utf8"), context, { filename: file });
  }
  return context.window;
}

/** A plain JPEG of the given size, as uploaded bytes. */
async function makeJpeg(width, height) {
  const sharp = require("sharp");
  return sharp({ create: { width, height, channels: 3, background: "#b07a5a" } }).jpeg().toBuffer();
}

/** A small valid PDF (US Letter) with `pages` pages of vector drawing. */
function makePdf(pages = 1) {
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>"];
  const kids = [];
  const pageObjs = [];
  for (let i = 0; i < pages; i++) {
    const pageNum = 3 + i * 2;
    kids.push(`${pageNum} 0 R`);
    const content = `0.85 0.34 0.17 rg 72 72 468 648 re f 1 1 1 rg 200 300 212 212 re f`;
    pageObjs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${pageNum + 1} 0 R >>`);
    pageObjs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  objs.push(`<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages} >>`, ...pageObjs);
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const ADDRESS = { line1: "1 Main St", city: "Winnipeg", region: "MB", postalCode: "R3C 0A1", country: "CA" };

/** A valid order body (POST /api/orders / createOrder), with overrides. */
function orderInput(items, overrides = {}) {
  return {
    customerName: "Jane Doe",
    customerEmail: "jane@example.com",
    customerPhone: "204-555-0100",
    shippingAddress: ADDRESS,
    acceptedFinalSale: true,
    items,
    ...overrides,
  };
}

/** Uploads a sharp photo through the real pipeline; returns its imageKey. */
async function uploadPhoto(width = 3000, height = 4000) {
  const { processUpload } = require(path.join(SRC, "services", "uploads"));
  return (await processUpload(await makeJpeg(width, height))).imageKey;
}

module.exports = {
  SRC,
  useTestDb,
  useTempUploads,
  stubStripe,
  captureEmails,
  startApp,
  loadFrontend,
  makeJpeg,
  makePdf,
  uploadPhoto,
  orderInput,
  ADDRESS,
};
