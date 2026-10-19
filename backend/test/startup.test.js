/** Production must refuse to start without the settings it can't work without. */
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const SERVER = path.join(__dirname, "..", "src", "server.js");
const SECRET_A = "a".repeat(40);
const SECRET_B = "b".repeat(40);
const GOOD = {
  NODE_ENV: "production",
  ADMIN_TOKEN: SECRET_A,
  FILE_LINK_SECRET: SECRET_B,
  FULFILLMENT_EMAIL: "orders@shop.example.com",
  SITE_URL: "https://shop.example.com",
  STRIPE_WEBHOOK_SECRET: "whsec_test_secret",
  DATABASE_URL: "postgres://user:pass@localhost:5432/cutout_website",
  HOST: "127.0.0.1",
  PORT: "0",
};

/** Starts the server (from a temp dir, so no .env is loaded) and reports what happened. */
function start(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], {
      cwd: os.tmpdir(),
      env: { PATH: process.env.PATH, ...env },
    });
    let output = "";
    const done = (result) => {
      child.kill();
      resolve({ ...result, output });
    };
    child.stdout.on("data", (d) => {
      output += d;
      if (/listening/.test(output)) done({ started: true });
    });
    child.stderr.on("data", (d) => (output += d));
    child.on("exit", (code) => done({ started: false, code }));
    setTimeout(() => done({ started: false, timedOut: true }), 10000);
  });
}

const without = (key) => {
  const env = { ...GOOD };
  delete env[key];
  return env;
};

test("starts with a complete production configuration", async () => {
  const r = await start(GOOD);
  assert.ok(r.started, r.output);
});

for (const key of ["FULFILLMENT_EMAIL", "ADMIN_TOKEN", "FILE_LINK_SECRET", "SITE_URL", "STRIPE_WEBHOOK_SECRET", "DATABASE_URL"]) {
  test(`refuses to start in production without ${key}`, async () => {
    const r = await start(without(key));
    assert.equal(r.started, false);
    assert.match(r.output, new RegExp(`Refusing to start: .*${key}`));
  });
}

test("refuses an http:// SITE_URL and a FULFILLMENT_EMAIL that isn't an email", async () => {
  assert.match((await start({ ...GOOD, SITE_URL: "http://shop.example.com" })).output, /SITE_URL/);
  assert.match((await start({ ...GOOD, FULFILLMENT_EMAIL: "orders" })).output, /FULFILLMENT_EMAIL/);
});

test("development starts without any of them", async () => {
  const r = await start({ HOST: "127.0.0.1", PORT: "0" });
  assert.ok(r.started, r.output);
});
