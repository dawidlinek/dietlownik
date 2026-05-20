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
  const sql = readFileSync(join(__dir, "migrate_v8_e5small.sql"), "utf8");
  try {
    await client.query(sql);
    console.log("v8 e5-small migration applied successfully.");
    console.log("");
    console.log("NEXT STEPS:");
    console.log("  1. npm run embed         # refill meal_embeddings (~3 min)");
    console.log("  2. npm run test          # verify scoring tests pass");
    console.log("");
    console.log("The keyword_embeddings cache fills lazily on first query.");
  } catch (err) {
    console.error("Migration failed:", err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

migrate();
