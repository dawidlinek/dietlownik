import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import pg from "pg";

const { Client } = pg;

const { DATABASE_URL } = process.env;
if (DATABASE_URL === undefined || DATABASE_URL === "") {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const sql = readFileSync(
  join(import.meta.dirname, "migrate_v12_company_city_history.sql"),
  "utf8"
);

const client = new Client({ connectionString: DATABASE_URL });
await client.connect();
try {
  await client.query(sql);
  console.log("v12 company_city_history applied.");
} catch (error) {
  console.error(
    "Migration failed:",
    error instanceof Error ? error.message : error
  );
  process.exitCode = 1;
} finally {
  await client.end();
}
