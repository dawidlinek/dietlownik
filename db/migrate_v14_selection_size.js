// v14 — scrape_runs.selection_size, the footer's "wycenionych dań"
// count (see scraper/selection-size.ts). Additive and idempotent; needs no
// earlier migration beyond scrape_runs existing.
//
//   node db/migrate_v14_selection_size.js
import "dotenv/config";
import pg from "pg";

const { Client } = pg;

const { DATABASE_URL } = process.env;
if (DATABASE_URL === undefined || DATABASE_URL === "") {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const client = new Client({ connectionString: DATABASE_URL });
await client.connect();
try {
  await client.query(
    "ALTER TABLE scrape_runs ADD COLUMN IF NOT EXISTS selection_size BIGINT"
  );
  console.log("[v14] scrape_runs.selection_size present");
} catch (error) {
  console.error(
    "[v14] failed:",
    error instanceof Error ? error.message : error
  );
  process.exitCode = 1;
} finally {
  await client.end();
}
