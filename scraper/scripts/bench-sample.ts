/**
 * bench-sample: for every query in `bench_queries`, build a stratified pool
 * of meals to label, and write them as `bench_label_jobs`. Pools are
 * RESTRICTED to meals on offer in a single (city, day) slice — the production
 * scoring query is also a city+day slice, so labels for off-slice meals would
 * be wasted.
 *
 * Stratification per query:
 *   - `text_match`     : meals (in the slice) whose name+ingredients ILIKE %query%
 *   - `embedding_pool` : top-K nearest neighbours under current meal_embeddings
 *   - `random`         : pure random distractors from the slice
 *
 *   BENCH_CITY=986283 BENCH_DAY=2026-05-20 npm run bench:sample
 *   # defaults: BENCH_CITY=986283 (Wrocław), BENCH_DAY=auto-pick busiest day
 *   BENCH_POOL_SIZE=150 BENCH_BATCH_SIZE=25 npm run bench:sample
 *   BENCH_RESET=1 npm run bench:sample
 */

import "dotenv/config";
import { query } from "../../lib/db.js";
import { embedKeyword, toPgVector } from "../../lib/embeddings.js";

const POOL_SIZE = Number.parseInt(process.env.BENCH_POOL_SIZE ?? "100", 10);
const BATCH_SIZE = Number.parseInt(process.env.BENCH_BATCH_SIZE ?? "30", 10);
const TEXT_MATCH_CAP = Math.floor(POOL_SIZE * 0.4);
const EMBEDDING_CAP = Math.floor(POOL_SIZE * 0.4);
// remainder = random distractors
const RESET = process.env.BENCH_RESET === "1";
// 986283 = Wrocław
const CITY_ID = Number.parseInt(process.env.BENCH_CITY ?? "986283", 10);
const DAY_OVERRIDE = process.env.BENCH_DAY;

interface QueryRow {
  query_id: number;
  query_text: string;
  query_family: string;
  label_source: string;
}

interface MealIdRow {
  // BIGINT → string from pg
  id: string;
}

const pickBusiestDay = async (cityId: number): Promise<string> => {
  const rows = await query<{ menu_date: string; distinct_meals: string }>(
    `SELECT menu_date::text, COUNT(DISTINCT meal_id)::text AS distinct_meals
       FROM daily_menu
      WHERE city_id = $1 AND meal_id IS NOT NULL
      GROUP BY menu_date
      ORDER BY COUNT(DISTINCT meal_id) DESC, menu_date DESC
      LIMIT 1`,
    [cityId]
  );
  if (rows.length === 0) {
    throw new Error(
      `no daily_menu rows for city_id=${cityId} — has the scrape finished any companies?`
    );
  }
  return rows[0].menu_date;
};

const pickMeals = async (
  q: Readonly<QueryRow>,
  cityId: number,
  day: string
): Promise<{ meal_id: number; stratum: string }[]> => {
  const seen = new Set<number>();
  const out: { meal_id: number; stratum: string }[] = [];

  // Common slice filter — meal must be on offer in the (city, day) slice.
  // The subquery is small (a few thousand meal_ids) so this is cheap.
  const SLICE = `
    id IN (
      SELECT DISTINCT meal_id
        FROM daily_menu
       WHERE city_id = $sliceCity AND menu_date = $sliceDay AND meal_id IS NOT NULL
    )
  `;

  // ── 1. text_match ────────────────────────────────────────────────────────
  const pattern = `%${q.query_text.replaceAll(/[%_]/g, "\\$&")}%`;
  const textRows = await query<MealIdRow>(
    `SELECT id::text FROM meals
      WHERE (name ILIKE $1 OR ingredients_raw ILIKE $1)
        AND ${SLICE.replace("$sliceCity", "$2").replace("$sliceDay", "$3")}
      ORDER BY RANDOM()
      LIMIT $4`,
    [pattern, cityId, day, TEXT_MATCH_CAP]
  );
  for (const r of textRows) {
    const id = Number.parseInt(r.id, 10);
    if (!seen.has(id)) {
      seen.add(id);
      out.push({ meal_id: id, stratum: "text_match" });
    }
  }

  // ── 2. embedding_pool — restricted to slice ──────────────────────────────
  try {
    const vec = await embedKeyword(q.query_text);
    const embRows = await query<MealIdRow>(
      `SELECT cme.meal_id::text AS id
         FROM current_meal_embeddings cme
        WHERE cme.meal_id IN (
                SELECT DISTINCT meal_id
                  FROM daily_menu
                 WHERE city_id = $2 AND menu_date = $3 AND meal_id IS NOT NULL
              )
        ORDER BY cme.embedding <=> $1::vector
        LIMIT $4`,
      [toPgVector(vec), cityId, day, EMBEDDING_CAP]
    );
    for (const r of embRows) {
      const id = Number.parseInt(r.id, 10);
      if (!seen.has(id)) {
        seen.add(id);
        out.push({ meal_id: id, stratum: "embedding_pool" });
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`  [${q.query_text}] embedding pool skipped: ${msg}`);
  }

  // ── 3. random fill from the slice ────────────────────────────────────────
  const remaining = POOL_SIZE - out.length;
  if (remaining > 0) {
    const seenList = [...seen];
    const randRows = await query<MealIdRow>(
      `SELECT id::text FROM meals
        WHERE NOT (id = ANY($1::bigint[]))
          AND ${SLICE.replace("$sliceCity", "$2").replace("$sliceDay", "$3")}
        ORDER BY RANDOM()
        LIMIT $4`,
      [seenList.length === 0 ? [-1] : seenList, cityId, day, remaining]
    );
    for (const r of randRows) {
      const id = Number.parseInt(r.id, 10);
      if (!seen.has(id)) {
        seen.add(id);
        out.push({ meal_id: id, stratum: "random" });
      }
    }
  }

  return out;
};

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
};

const main = async (): Promise<void> => {
  const day = DAY_OVERRIDE ?? (await pickBusiestDay(CITY_ID));

  // Sanity: surface the slice size so the user can react if it's tiny.
  const sliceRows = await query<{ n: string }>(
    `SELECT COUNT(DISTINCT meal_id)::text AS n
       FROM daily_menu
      WHERE city_id = $1 AND menu_date = $2 AND meal_id IS NOT NULL`,
    [CITY_ID, day]
  );
  const sliceSize = Number.parseInt(sliceRows[0]?.n ?? "0", 10);
  console.log(
    `slice: city_id=${CITY_ID} day=${day}  →  ${sliceSize} distinct meals on offer`
  );
  if (sliceSize === 0) {
    console.error("empty slice — nothing to label. Pick a different day.");
    process.exit(1);
  }
  if (sliceSize < POOL_SIZE) {
    console.warn(
      `  slice (${sliceSize}) is smaller than pool size (${POOL_SIZE}) — pools will be capped at slice size`
    );
  }

  if (RESET) {
    console.log("BENCH_RESET=1 — deleting existing jobs + items");
    await query("TRUNCATE bench_label_jobs CASCADE");
  }

  const queries = await query<QueryRow>(
    `SELECT query_id, query_text, query_family, label_source
       FROM bench_queries
      ORDER BY query_id`
  );

  if (queries.length === 0) {
    console.error("no bench_queries — run bench-init first");
    process.exit(1);
  }

  console.log(
    `sampling up to ${POOL_SIZE} meals/query for ${queries.length} queries (batch=${BATCH_SIZE})\n`
  );

  let totalJobs = 0;
  let totalMeals = 0;

  for (const q of queries) {
    if (!RESET) {
      const existing = await query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM bench_label_jobs WHERE query_id = $1`,
        [q.query_id]
      );
      if (Number.parseInt(existing[0]?.n ?? "0", 10) > 0) {
        console.log(`  [${q.query_text}] existing jobs — skip`);
        continue;
      }
    }

    const pool = await pickMeals(q, CITY_ID, day);
    if (pool.length === 0) {
      console.log(`  [${q.query_text}] empty pool`);
      continue;
    }

    const batches = chunk(pool, BATCH_SIZE);
    for (let i = 0; i < batches.length; i += 1) {
      const jobRows = await query<{ job_id: string }>(
        `INSERT INTO bench_label_jobs (query_id, batch_index)
              VALUES ($1, $2)
         RETURNING job_id::text`,
        [q.query_id, i]
      );
      const jobId = Number.parseInt(jobRows[0].job_id, 10);
      for (const item of batches[i]) {
        await query(
          `INSERT INTO bench_label_job_items (job_id, meal_id, stratum)
                VALUES ($1, $2, $3)
           ON CONFLICT (job_id, meal_id) DO NOTHING`,
          [jobId, item.meal_id, item.stratum]
        );
      }
      totalJobs += 1;
      totalMeals += batches[i].length;
    }

    const strataCounts: Record<string, number> = {};
    for (const p of pool) {
      strataCounts[p.stratum] = (strataCounts[p.stratum] ?? 0) + 1;
    }
    const strataDesc = Object.entries(strataCounts)
      .map((entry: readonly [string, number]) => `${entry[0]}=${entry[1]}`)
      .join(" ");
    console.log(
      `  [${q.query_text.padEnd(28)}] pool=${pool.length} batches=${batches.length} (${strataDesc})`
    );
  }

  console.log(
    `\ncreated ${totalJobs} jobs totalling ${totalMeals} meal labels`
  );
  console.log(`scope: city_id=${CITY_ID} day=${day}`);
};

try {
  await main();
  process.exit(0);
} catch (error) {
  console.error("bench-sample failed:", error);
  process.exit(1);
}
