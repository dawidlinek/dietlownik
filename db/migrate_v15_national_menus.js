// v15 upgrade runner — see db/migrate_v15_national_menus.sql.
//
//   node db/migrate_v15_national_menus.js   migrate (one transaction), then verify
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
  join(import.meta.dirname, "migrate_v15_national_menus.sql"),
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

// Row counts taken before the migration, compared after it.
const COUNT_SQL = `SELECT count(*)::bigint AS total,
                          count(*) FILTER (WHERE closed_at IS NULL)::bigint AS open
                     FROM menu_items`;

// Each returns one row { ok, detail }.
const checks = (before) => [
  {
    name: "menu_items has no city_id",
    sql: `SELECT NOT EXISTS (SELECT 1 FROM information_schema.columns
                               WHERE table_schema = 'public'
                                 AND table_name = 'menu_items'
                                 AND column_name = 'city_id') AS ok,
                 'column dropped' AS detail`,
  },
  {
    name: "no menu span lost",
    sql: `SELECT total = ${before.total} AND open = ${before.open} AS ok,
                 format('total %s (was ${before.total}), open %s (was ${before.open})',
                        total, open) AS detail
            FROM (${COUNT_SQL}) c`,
  },
  {
    name: "one open span per (leaf, date, option)",
    sql: `SELECT n = 0 AS ok, format('%s duplicated open keys', n) AS detail
          FROM (SELECT count(*) AS n FROM (
                  SELECT 1 FROM menu_items WHERE closed_at IS NULL
                  GROUP BY company_id, diet_calories_id, tier_id, menu_date,
                           api_meal_slot_id
                  HAVING count(*) > 1) d) x`,
  },
  {
    name: "current_menu_items matches the open spans",
    sql: `SELECT a = b AS ok, format('view %s rows, open spans %s', a, b) AS detail
          FROM (SELECT (SELECT count(*) FROM current_menu_items) AS a,
                       (SELECT count(*) FROM menu_items
                         WHERE closed_at IS NULL) AS b) x`,
  },
];

const client = new Client({ connectionString: DATABASE_URL });
await client.connect();
const t0 = Date.now();
try {
  await client.query("SET maintenance_work_mem = '1GB'");
  const {
    rows: [before],
  } = await client.query(COUNT_SQL);
  await client.query("BEGIN");
  try {
    for (const step of parseSteps(sql)) {
      const ts = Date.now();
      await client.query(step.sql);
      console.log(`[v15] ${step.name} (${elapsed(ts)})`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
  console.log(`[v15] migrated in ${elapsed(t0)}`);
  let ok = true;
  for (const check of checks(before)) {
    const { rows } = await client.query(check.sql);
    const [row] = rows;
    const passed = row?.ok === true;
    if (!passed) {
      ok = false;
    }
    console.log(
      `[v15:verify] [${passed ? " ok " : "FAIL"}] ${check.name} — ${row?.detail ?? ""}`
    );
  }
  if (!ok) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(
    "[v15] failed:",
    error instanceof Error ? error.message : error
  );
  process.exitCode = 1;
} finally {
  await client.end();
}
