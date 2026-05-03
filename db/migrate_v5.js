import "dotenv/config";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import pg from "pg";

const { Client } = pg;
const __dir = dirname(fileURLToPath(import.meta.url));

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is not set");

async function migrate() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  console.log("Connected to PostgreSQL.");
  const sql = readFileSync(join(__dir, "migrate_v5.sql"), "utf8");
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
    console.log("v5 migration applied successfully.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

migrate();
