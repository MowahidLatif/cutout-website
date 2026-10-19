/**
 * Shared test setup. Tests run with Node's built-in runner (`npm test`) and
 * never touch your real database: the services get an in-process Postgres
 * (PGlite) with every migration applied, and uploads go to a temp folder.
 *
 * Each test file runs in its own process, so call these at the top of a
 * file BEFORE requiring anything from src/.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "src");
const FRONTEND = path.join(__dirname, "..", "..", "frontend");

/** Replaces src/db/pool.js with an in-memory Postgres that has all migrations applied. */
async function useTestDb() {
  const { PGlite } = await import("@electric-sql/pglite");
  const { pgcrypto } = await import("@electric-sql/pglite/contrib/pgcrypto");
  const db = await PGlite.create({ extensions: { pgcrypto } });
  // pg reports rowCount; PGlite reports affectedRows (and nothing for SELECTs).
  const query = async (sql, params) => {
    const r = await db.query(sql, params);
    return { ...r, rowCount: r.affectedRows || r.rows.length };
  };
  const poolPath = require.resolve(path.join(SRC, "db", "pool.js"));
  require.cache[poolPath] = {
    id: poolPath,
    filename: poolPath,
    loaded: true,
    exports: { query, connect: async () => ({ query, release() {} }), end: async () => {} },
  };
  const dir = path.join(SRC, "db", "migrations");
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(fs.readFileSync(path.join(dir, file), "utf8"));
  }
  return db;
}

/** Points the disk storage driver at a fresh temp folder. */
function useTempUploads() {
  process.env.STORAGE_DRIVER = "disk";
  process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cutout-test-uploads-"));
  return process.env.UPLOAD_DIR;
}

/** Replaces the Stripe SDK; returns an object whose `.params` is the last session sent. */
function stubStripe() {
  const sent = { params: null };
  const stripePath = require.resolve("stripe");
  require.cache[stripePath] = {
    id: stripePath,
    filename: stripePath,
    loaded: true,
    exports: function Stripe() {
      return {
        checkout: {
          sessions: {
            create: async (params) => {
              sent.params = params;
              return { id: "cs_test", url: "https://checkout.stripe.test/session" };
            },
          },
        },
      };
    },
  };
  process.env.STRIPE_SECRET_KEY = "sk_test_stub";
  return sent;
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

module.exports = { SRC, useTestDb, useTempUploads, stubStripe, loadFrontend, makeJpeg, makePdf, ADDRESS };
