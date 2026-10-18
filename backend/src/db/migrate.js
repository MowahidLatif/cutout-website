/**
 * Tiny migration runner: applies every .sql file in db/migrations, in
 * filename order, inside a single transaction per file. No migration
 * framework needed at this size — just run `npm run migrate`.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const pool = require("./pool");

async function run() {
  const dir = path.join(__dirname, "migrations");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    console.log(`Applying migration: ${file}`);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(`Migration ${file} failed:`, err.message);
      process.exitCode = 1;
      break;
    } finally {
      client.release();
    }
  }

  await pool.end();
}

run();
