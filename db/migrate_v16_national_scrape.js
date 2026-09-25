// v16 upgrade runner — see db/migrate_v16_national_scrape.sql.
//
//   node db/migrate_v16_national_scrape.js   migrate (one transaction), then verify
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
  join(import.meta.dirname, "migrate_v16_national_scrape.sql"),
  "utf8"
);

/**
 * Split the migration file into named steps on `-- @step <name>` markers.
 *
 * @param {string} text the whole file
 * @returns {{ name: string, sql: string }[]} steps in file order
 */
const parseSteps = (text) => {
  const steps = [];
  let current = null;
  for (const line of text.split("\n")) {
    const m = /^-- @step (\S+)/u.exec(line);
    if (m !== null) {
      current = { name: m[1], sql: "" };
      steps.push(current);
    } else if (current !== null) {
      current.sql += `${line}\n`;
    }
  }
  return steps;
};

const elapsed = (t0) => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

// Current prices per city before the migration: city_quotes() must return
// exactly these afterwards (every existing membership is its own price city,
// so no delivery fee is swapped).
const PRICES_SQL = `SELECT city_id::text AS city_id, count(*)::bigint AS n,
                           COALESCE(sum(total_cost), 0)::text AS total
                      FROM price_history WHERE closed_at IS NULL
                     GROUP BY city_id ORDER BY city_id`;

// Each returns one row { ok, detail }.
const checks = (before) => [
  {
    name: "every membership has a price city",
    sql: `SELECT n = 0 AS ok, format('%s memberships without price_city_id', n) AS detail
          FROM (SELECT count(*) AS n FROM company_cities
                 WHERE price_city_id IS NULL) x`,
  },
  {
    name: "every catering with a membership has a home city",
    sql: `SELECT n = 0 AS ok, format('%s caterings without home_city_id', n) AS detail
          FROM (SELECT count(*) AS n FROM companies co
                 WHERE co.home_city_id IS NULL
                   AND EXISTS (SELECT 1 FROM company_cities cc
                                WHERE cc.company_id = co.company_id)) x`,
  },
  ...before.map((b) => ({
    name: `city_quotes(${b.city_id}) returns the city's quotes unchanged`,
    sql: `SELECT n = ${b.n} AND total = '${b.total}' AS ok,
                 format('%s current quotes (was ${b.n}), sum total_cost %s (was ${b.total})',
                        n, total) AS detail
            FROM (SELECT count(*)::bigint AS n,
                         COALESCE(sum(total_cost), 0)::text AS total
                    FROM city_quotes(${b.city_id}) WHERE closed_at IS NULL) x`,
  })),
  {
    name: "tracked cities",
    info: true,
    sql: `SELECT TRUE AS ok, format('%s tracked: %s', count(*), string_agg(name, ', ')) AS detail
            FROM cities WHERE tracked`,
  },
];

const client = new Client({ connectionString: DATABASE_URL });
await client.connect();
const t0 = Date.now();
try {
  await client.query("SET maintenance_work_mem = '1GB'");
  const { rows: before } = await client.query(PRICES_SQL);
  await client.query("BEGIN");
  try {
    for (const step of parseSteps(sql)) {
      const ts = Date.now();
      await client.query(step.sql);
      console.log(`[v16] ${step.name} (${elapsed(ts)})`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
  console.log(`[v16] migrated in ${elapsed(t0)}`);
  let ok = true;
  for (const check of checks(before)) {
    const { rows } = await client.query(check.sql);
    const [row] = rows;
    const passed = row?.ok === true;
    if (!passed && check.info !== true) {
      ok = false;
    }
    const tag = check.info === true ? "info" : passed ? " ok " : "FAIL";
    console.log(`[v16:verify] [${tag}] ${check.name} — ${row?.detail ?? ""}`);
  }
  if (!ok) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(
    "[v16] failed:",
    error instanceof Error ? error.message : error
  );
  process.exitCode = 1;
} finally {
  await client.end();
}
