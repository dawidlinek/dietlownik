import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import pg from "pg";

const { Client } = pg;

const here = import.meta.dirname;

const { DATABASE_URL } = process.env;
if (DATABASE_URL === undefined || DATABASE_URL === "") {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const flags = new Set(process.argv.slice(2));
const seedTaxonomy = flags.has("--seed-taxonomy");
// --reset is a no-op flag — the default behavior is already drop-and-recreate.
// It exists as an explicit affirmation for callers who want to be loud about intent.
const explicitReset = flags.has("--reset");

const schemaPath = join(here, "schema.sql");
const taxonomyPath = join(here, "seed", "taxonomy.sql");

const schemaSql = readFileSync(schemaPath, "utf-8");
const taxonomySql = seedTaxonomy ? readFileSync(taxonomyPath, "utf-8") : null;

/**
 * Pull a numeric scalar out of `pg`'s loosely typed query result. `pg` types
 * `.rows` as `any[]`, so we narrow here to satisfy `no-unsafe-member-access`.
 *
 * @param {Readonly<{ rows: ReadonlyArray<Readonly<Record<string, unknown>>> }>} result the pg.QueryResult
 * @param {string} col the column name to look up on the first row
 * @returns {number | string | null} the scalar value, or null when absent or non-scalar
 */
const scalar = (result, col) => {
  const [row] = result.rows;
  if (row === undefined) {
    return null;
  }
  const v = row[col];
  if (typeof v === "number" || typeof v === "string") {
    return v;
  }
  return null;
};

const main = async () => {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  console.log(
    `[migrate_fresh] connected (reset=${explicitReset ? "explicit" : "default"}, seed-taxonomy=${seedTaxonomy})`
  );

  try {
    await client.query("BEGIN");

    console.log("[migrate_fresh] dropping public schema");
    await client.query("DROP SCHEMA IF EXISTS public CASCADE");
    await client.query("CREATE SCHEMA public");
    await client.query("GRANT ALL ON SCHEMA public TO public");

    console.log("[migrate_fresh] creating extensions: vector, pg_trgm");
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");
    await client.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");

    console.log(`[migrate_fresh] executing ${schemaPath}`);
    await client.query(schemaSql);

    if (seedTaxonomy && taxonomySql !== null && taxonomySql !== "") {
      console.log(`[migrate_fresh] executing ${taxonomyPath}`);
      await client.query(taxonomySql);
    }

    await client.query("COMMIT");

    const tableCount = await client.query(
      "SELECT COUNT(*)::int AS n FROM pg_tables WHERE schemaname = 'public'"
    );
    const viewCount = await client.query(
      "SELECT COUNT(*)::int AS n FROM pg_views WHERE schemaname = 'public'"
    );
    const extCount = await client.query(
      "SELECT COUNT(*)::int AS n FROM pg_extension WHERE extname IN ('vector', 'pg_trgm')"
    );
    console.log(
      `[migrate_fresh] done — tables=${scalar(tableCount, "n")}, views=${scalar(viewCount, "n")}, target extensions=${scalar(extCount, "n")}/2`
    );

    if (seedTaxonomy) {
      const taxRows = await client.query(
        "SELECT COUNT(*)::int AS categories FROM ingredient_taxonomy"
      );
      const memberRows = await client.query(
        "SELECT COUNT(*)::int AS members FROM ingredient_taxonomy_members"
      );
      console.log(
        `[migrate_fresh] taxonomy seeded — categories=${scalar(taxRows, "categories")}, members=${scalar(memberRows, "members")}`
      );
    }
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore — connection may already be in a bad state */
    }
    if (error instanceof Error) {
      console.error("[migrate_fresh] failed:", error.message);
      if (error.stack !== undefined && error.stack !== "") {
        console.error(error.stack);
      }
    } else {
      console.error("[migrate_fresh] failed:", error);
    }
    process.exitCode = 1;
  } finally {
    await client.end();
  }
};

try {
  await main();
} catch (error) {
  console.error("[migrate_fresh] uncaught:", error);
  process.exit(1);
}
