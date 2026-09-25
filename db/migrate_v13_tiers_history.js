// v13 upgrade runner — see db/migrate_v13_tiers_history.sql.
//
//   node db/migrate_v13_tiers_history.js   migrate (one transaction), then verify
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
  join(import.meta.dirname, "migrate_v13_tiers_history.sql"),
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

// Each returns one row { ok, detail }.
const CHECKS = [
  {
    name: "every price span belongs to a catalog leaf",
    sql: `SELECT n = 0 AS ok, format('%s orphan price spans', n) AS detail
          FROM (SELECT count(*) AS n FROM price_history h
                WHERE NOT EXISTS (SELECT 1 FROM diet_calories dc
                  WHERE dc.company_id = h.company_id
                    AND dc.diet_calories_id = h.diet_calories_id
                    AND dc.tier_id = h.tier_id)) x`,
  },
  {
    name: "every menu span belongs to a catalog leaf",
    sql: `SELECT n = 0 AS ok, format('%s orphan menu spans', n) AS detail
          FROM (SELECT count(*) AS n FROM menu_items mi
                WHERE NOT EXISTS (SELECT 1 FROM diet_calories dc
                  WHERE dc.company_id = mi.company_id
                    AND dc.diet_calories_id = mi.diet_calories_id
                    AND dc.tier_id = mi.tier_id)) x`,
  },
  {
    name: "one open price span per (leaf, city, days, promo set)",
    sql: `SELECT n = 0 AS ok, format('%s duplicated open keys', n) AS detail
          FROM (SELECT count(*) AS n FROM (
                  SELECT 1 FROM price_history WHERE closed_at IS NULL
                  GROUP BY company_id, diet_calories_id, tier_id, city_id,
                           order_days, promo_codes
                  HAVING count(*) > 1) d) x`,
  },
  {
    name: "ingredient view returns every variant's list",
    sql: `SELECT a = b AS ok, format('view %s rows, variant_ingredients %s rows', a, b) AS detail
          FROM (SELECT (SELECT count(*) FROM meal_ingredients) AS a,
                       (SELECT count(*) FROM variant_ingredients) AS b) x`,
  },
  {
    name: "history seeds",
    info: true,
    sql: `SELECT TRUE AS ok, format('company_history %s, campaign_history %s, open menu spans with photo %s / %s',
                 (SELECT count(*) FROM company_history),
                 (SELECT count(*) FROM campaign_history),
                 (SELECT count(image_url) FROM menu_items WHERE closed_at IS NULL),
                 (SELECT count(*) FROM menu_items WHERE closed_at IS NULL)) AS detail`,
  },
  {
    name: "sizes",
    info: true,
    sql: `SELECT TRUE AS ok, string_agg(format('%s=%s', relname,
                   pg_size_pretty(pg_total_relation_size(relid))), ', ' ORDER BY relname) AS detail
          FROM pg_stat_user_tables
          WHERE relname IN ('ingredient_names', 'variant_ingredients', 'price_history',
                            'diet_calories', 'company_history', 'campaign_history')`,
  },
];

const client = new Client({ connectionString: DATABASE_URL });
await client.connect();
const t0 = Date.now();
try {
  await client.query("SET maintenance_work_mem = '1GB'");
  await client.query("BEGIN");
  try {
    for (const step of parseSteps(sql)) {
      const ts = Date.now();
      await client.query(step.sql);
      console.log(`[v13] ${step.name} (${elapsed(ts)})`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
  console.log(`[v13] migrated in ${elapsed(t0)}`);
  let ok = true;
  for (const check of CHECKS) {
    const { rows } = await client.query(check.sql);
    const [row] = rows;
    const passed = row?.ok === true;
    if (!passed && check.info !== true) {
      ok = false;
    }
    const tag = check.info === true ? "info" : passed ? " ok " : "FAIL";
    console.log(`[v13:verify] [${tag}] ${check.name} — ${row?.detail ?? ""}`);
  }
  if (!ok) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(
    "[v13] failed:",
    error instanceof Error ? error.message : error
  );
  process.exitCode = 1;
} finally {
  await client.end();
}
