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
  const sql = readFileSync(join(__dir, "migrate_v9_form_settings.sql"), "utf8");
  try {
    await client.query(sql);
    console.log("v9 form_settings migration applied successfully.");
    console.log("");
    console.log("NEXT STEPS:");
    console.log(
      "  1. tsx scraper/scripts/sync-form-settings.ts   # backfill from /constant for every company"
    );
    console.log(
      "  2. tsx scraper/scripts/clean-hidden-bodies.ts  # null out kcal/ingredients for opted-out caterings"
    );
    console.log("");
  } catch (err) {
    console.error("Migration failed:", err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

migrate();
