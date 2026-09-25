// v11 upgrade runner — see db/migrate_v11_history.sql for what it does.
//
//   node db/migrate_v11_history.js             migrate (one transaction), then verify
//   node db/migrate_v11_history.js --verify    only run the conversion checks
//   node db/migrate_v11_history.js --finalize  verify, then drop the legacy tables
//                                              whose content the new ones fully hold
//                                              (legacy_daily_menu, legacy_prices,
//                                              legacy_meal_embeddings)
//
// legacy_meals_history and legacy_meal_ingredients_snapshots are never
// dropped by this script: per-version label/thermo/allergens and the exact
// write order can't be rebuilt from the new tables.
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

const flags = new Set(process.argv.slice(2));
const verifyOnly = flags.has("--verify");
const finalize = flags.has("--finalize");

const sqlPath = join(import.meta.dirname, "migrate_v11_history.sql");

/**
 * Split the migration file into named steps on `-- @step <name>` markers.
 *
 * @param {string} sql the whole file
 * @returns {{ name: string, sql: string }[]} steps in file order
 */
const parseSteps = (sql) => {
  const steps = [];
  let current = null;
  for (const line of sql.split("\n")) {
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

// Each check returns one row: { ok: boolean, detail: text }.
//
// Scraping continues after the migration, so spans gain observations and new
// spans appear before --finalize runs. Every check therefore compares the
// legacy period only: up to the last legacy capture (the cutoff). A span still
// being extended at the cutoff is counted by the legacy rows it covers, not by
// its (by now larger) observation count.
const MENU_CUTOFF = "(SELECT max(captured_at) FROM legacy_daily_menu)";
const PRICE_CUTOFF = "(SELECT max(captured_at) FROM legacy_prices)";
// Observations a span made in the legacy period.
const MENU_LEGACY_OBS = `CASE WHEN mi.last_seen_at <= ${MENU_CUTOFF} THEN mi.observations
  ELSE (SELECT count(*) FROM legacy_daily_menu dm
        WHERE dm.company_id = mi.company_id AND dm.diet_calories_id = mi.diet_calories_id
          AND dm.menu_date = mi.menu_date AND dm.city_id = mi.city_id
          AND dm.tier_id = mi.tier_id AND dm.api_meal_slot_id = mi.api_meal_slot_id
          AND dm.captured_at BETWEEN mi.first_seen_at AND mi.last_seen_at) END`;
const PRICE_LEGACY_OBS = `CASE WHEN h.last_seen_at <= ${PRICE_CUTOFF} THEN h.observations
  ELSE (SELECT count(*) FROM legacy_prices p
        WHERE p.company_id = h.company_id AND p.diet_calories_id = h.diet_calories_id
          AND p.city_id = h.city_id AND p.order_days = h.order_days
          AND p.promo_codes = h.promo_codes
          AND p.captured_at BETWEEN h.first_seen_at AND h.last_seen_at) END`;

const CHECKS = [
  {
    name: "menu: legacy-period observations add up to the legacy row count",
    sql: `SELECT a = b AS ok, format('spans hold %s legacy observations, legacy has %s rows', a, b) AS detail
          FROM (SELECT (SELECT COALESCE(sum(${MENU_LEGACY_OBS}), 0) FROM menu_items mi
                        WHERE mi.first_seen_at <= ${MENU_CUTOFF}) AS a,
                       (SELECT count(*) FROM legacy_daily_menu) AS b) x`,
  },
  {
    name: "menu: every legacy row lies inside a span with the same option and dish",
    sql: `SELECT n = 0 AS ok, format('%s legacy rows not covered', n) AS detail
          FROM (SELECT count(*) AS n FROM legacy_daily_menu dm
                WHERE NOT EXISTS (
                  SELECT 1 FROM menu_items mi
                  WHERE mi.company_id = dm.company_id
                    AND mi.diet_calories_id = dm.diet_calories_id
                    AND mi.menu_date = dm.menu_date
                    AND mi.city_id = dm.city_id
                    AND mi.tier_id = dm.tier_id
                    AND mi.api_meal_slot_id = dm.api_meal_slot_id
                    AND dm.captured_at BETWEEN mi.first_seen_at AND mi.last_seen_at
                    AND mi.meal_id = dm.meal_id
                    AND mi.is_default = dm.is_default
                    AND mi.slot_name = dm.slot_name)) x`,
  },
  {
    name: "menu: no span claims presence in a fetch that lacked the option",
    setup: `CREATE TEMP TABLE IF NOT EXISTS v11_menu_fetches AS
              SELECT DISTINCT company_id, city_id, diet_calories_id, tier_id, menu_date, captured_at
              FROM legacy_daily_menu;
            CREATE INDEX IF NOT EXISTS v11_menu_fetches_idx ON v11_menu_fetches
              (company_id, diet_calories_id, menu_date, city_id, tier_id, captured_at);
            ANALYZE v11_menu_fetches;`,
    sql: `SELECT n = 0 AS ok, format('%s spans cover more legacy fetches than they observed', n) AS detail
          FROM (SELECT count(*) AS n FROM menu_items mi
                WHERE mi.first_seen_at <= ${MENU_CUTOFF}
                  AND ${MENU_LEGACY_OBS} <> (
                  SELECT count(*) FROM v11_menu_fetches f
                  WHERE f.company_id = mi.company_id
                    AND f.diet_calories_id = mi.diet_calories_id
                    AND f.menu_date = mi.menu_date
                    AND f.city_id = mi.city_id
                    AND f.tier_id = mi.tier_id
                    AND f.captured_at BETWEEN mi.first_seen_at AND mi.last_seen_at)) x`,
  },
  {
    name: "menu: spans of one option never overlap",
    sql: `SELECT n = 0 AS ok, format('%s overlapping span pairs', n) AS detail
          FROM (SELECT count(*) AS n FROM (
                  SELECT first_seen_at,
                         lag(last_seen_at) OVER (
                           PARTITION BY company_id, city_id, diet_calories_id, tier_id,
                                        menu_date, api_meal_slot_id
                           ORDER BY first_seen_at) AS prev_last,
                         lag(closed_at) OVER (
                           PARTITION BY company_id, city_id, diet_calories_id, tier_id,
                                        menu_date, api_meal_slot_id
                           ORDER BY first_seen_at) AS prev_closed
                  FROM menu_items) s
                WHERE s.prev_last IS NOT NULL
                  AND (s.first_seen_at <= s.prev_last OR s.prev_closed IS NULL
                       OR s.prev_closed > s.first_seen_at)) x`,
  },
  {
    name: "prices: legacy-period observations add up to the legacy row count",
    sql: `SELECT a = b AS ok, format('spans hold %s legacy observations, legacy has %s rows', a, b) AS detail
          FROM (SELECT (SELECT COALESCE(sum(${PRICE_LEGACY_OBS}), 0) FROM price_history h
                        WHERE h.first_seen_at <= ${PRICE_CUTOFF}) AS a,
                       (SELECT count(*) FROM legacy_prices) AS b) x`,
  },
  {
    name: "prices: every legacy quote lies inside a span with identical values",
    sql: `SELECT n = 0 AS ok, format('%s legacy quotes not covered', n) AS detail
          FROM (SELECT count(*) AS n FROM legacy_prices p
                WHERE NOT EXISTS (
                  SELECT 1 FROM price_history h
                  WHERE h.company_id = p.company_id
                    AND h.diet_calories_id = p.diet_calories_id
                    AND h.city_id = p.city_id
                    AND h.order_days = p.order_days
                    AND h.promo_codes = p.promo_codes
                    AND p.captured_at BETWEEN h.first_seen_at AND h.last_seen_at
                    AND ROW(h.per_day_cost, h.total_cost, h.total_cost_without_discounts,
                            h.total_lowest_30days_cost_without_discounts,
                            h.total_delivery_cost, h.total_delivery_discount,
                            h.total_promo_code_discount, h.total_promo_code_discount_info,
                            h.total_order_length_discount, h.total_deliveries_on_date_discount,
                            h.total_loyalty_points_discount, h.total_pickup_point_discount,
                            h.total_one_time_side_orders_cost,
                            h.total_awarded_loyalty_program_points,
                            h.total_awarded_global_loyalty_program_points)
                        IS NOT DISTINCT FROM
                        ROW(p.per_day_cost, p.total_cost, p.total_cost_without_discounts,
                            p.total_lowest_30days_cost_without_discounts,
                            p.total_delivery_cost, p.total_delivery_discount,
                            p.total_promo_code_discount, p.total_promo_code_discount_info,
                            p.total_order_length_discount, p.total_deliveries_on_date_discount,
                            p.total_loyalty_points_discount, p.total_pickup_point_discount,
                            p.total_one_time_side_orders_cost,
                            p.total_awarded_loyalty_program_points,
                            p.total_awarded_global_loyalty_program_points))) x`,
  },
  {
    name: "prices: spans of one series never overlap",
    sql: `SELECT n = 0 AS ok, format('%s overlapping span pairs', n) AS detail
          FROM (SELECT count(*) AS n FROM (
                  SELECT first_seen_at,
                         lag(last_seen_at) OVER w AS prev_last,
                         lag(closed_at) OVER w AS prev_closed
                  FROM price_history
                  WINDOW w AS (PARTITION BY company_id, diet_calories_id, city_id,
                                            order_days, promo_codes
                               ORDER BY first_seen_at)) s
                WHERE s.prev_last IS NOT NULL
                  AND (s.first_seen_at <= s.prev_last OR s.prev_closed IS NULL
                       OR s.prev_closed > s.first_seen_at)) x`,
  },
  {
    name: "variants: every legacy ingredient list survives as a variant",
    sql: `WITH legacy AS (
            SELECT DISTINCT meal_id, md5(ingredients::text) AS h
            FROM legacy_meal_ingredients_snapshots
          ), rebuilt AS (
            SELECT v.meal_id,
                   md5(COALESCE((
                     SELECT jsonb_agg(jsonb_build_object(
                              'position', mi.position, 'name_raw', mi.name_raw,
                              'name_normalized', mi.name_normalized, 'is_major', mi.is_major)
                            ORDER BY mi.position)
                     FROM meal_ingredients mi WHERE mi.variant_id = v.id), '[]'::jsonb)::text) AS h
            FROM meal_variants v
          )
          SELECT n = 0 AS ok, format('%s legacy lists with no variant', n) AS detail
          FROM (SELECT count(*) AS n FROM legacy l
                WHERE NOT EXISTS (SELECT 1 FROM rebuilt r WHERE r.meal_id = l.meal_id AND r.h = l.h)) x`,
  },
  {
    name: "info: menu option attribution coverage",
    info: true,
    sql: `SELECT TRUE AS ok,
                 format('%s spans; variant known on %s%%, kcal known on %s%%, open %s',
                        count(*),
                        round(100.0 * count(variant_id) / GREATEST(count(*), 1), 2),
                        round(100.0 * count(kcal) / GREATEST(count(*), 1), 2),
                        count(*) FILTER (WHERE closed_at IS NULL)) AS detail
          FROM menu_items`,
  },
  {
    name: "info: sizes",
    info: true,
    sql: `SELECT TRUE AS ok, string_agg(format('%s=%s rows/%s', relname, n_live_tup,
                   pg_size_pretty(pg_total_relation_size(relid))), ', ' ORDER BY relname) AS detail
          FROM pg_stat_user_tables
          WHERE relname IN ('menu_items', 'price_history', 'meal_variants', 'meal_ingredients',
                            'variant_embeddings', 'meals')`,
  },
];

const runChecks = async (client) => {
  let allOk = true;
  for (const check of CHECKS) {
    const t0 = Date.now();
    if (check.setup !== undefined) {
      await client.query(check.setup);
    }
    const { rows } = await client.query(check.sql);
    const [row] = rows;
    const ok = row?.ok === true;
    if (!ok && check.info !== true) {
      allOk = false;
    }
    const tag = check.info === true ? "info" : ok ? " ok " : "FAIL";
    console.log(
      `[v11:verify] [${tag}] ${check.name} — ${row?.detail ?? "(no row)"} (${elapsed(t0)})`
    );
  }
  return allOk;
};

const migrate = async (client) => {
  const steps = parseSteps(readFileSync(sqlPath, "utf8"));
  // Large sorts and temp tables; session-local, gone on disconnect.
  await client.query("SET work_mem = '1GB'");
  await client.query("SET maintenance_work_mem = '2GB'");
  await client.query("SET temp_buffers = '2GB'");
  await client.query("SET max_parallel_workers_per_gather = 4");
  await client.query("BEGIN");
  try {
    for (const step of steps) {
      const t0 = Date.now();
      await client.query(step.sql);
      console.log(`[v11] ${step.name} (${elapsed(t0)})`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
};

const dropLegacy = async (client) => {
  for (const table of [
    "legacy_daily_menu",
    "legacy_prices",
    "legacy_meal_embeddings",
  ]) {
    await client.query(`DROP TABLE IF EXISTS ${table}`);
    console.log(`[v11:finalize] dropped ${table}`);
  }
};

const main = async () => {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  const t0 = Date.now();
  try {
    if (!verifyOnly && !finalize) {
      await migrate(client);
      console.log(`[v11] migrated in ${elapsed(t0)}`);
    }
    await client.query("SET work_mem = '512MB'");
    const ok = await runChecks(client);
    if (!ok) {
      console.error(
        "[v11:verify] conversion checks FAILED — legacy tables kept"
      );
      process.exitCode = 1;
      return;
    }
    console.log("[v11:verify] all conversion checks passed");
    if (finalize) {
      await dropLegacy(client);
    }
  } finally {
    await client.end();
  }
};

try {
  await main();
} catch (error) {
  console.error(
    "[v11] failed:",
    error instanceof Error ? error.message : error
  );
  process.exitCode = 1;
}
