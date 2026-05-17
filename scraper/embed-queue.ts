// Per-run embedding queue + flush helper.
//
// During a scrape run, `menus.ts` calls `enqueueMealForEmbedding(mealId)` for
// every meal that was newly inserted or whose fingerprint drifted. At end of
// run, `scraper/index.ts` invokes `flushEmbeddings()`, which loads the queued
// meals, builds the passage text identically to the backfill script, runs the
// embedder in batches of 16, and inserts into `meal_embeddings` with
// `ON CONFLICT DO NOTHING`. Errors are non-fatal — a stale model or unreachable
// HF cache must not break the scrape.

import { query } from "../lib/db.js";
import { getEmbedder, toPgVector } from "../lib/embeddings.js";

const BATCH_SIZE = 16;

// Module-level queue. Scraper is single-process; this is shared state per run.
const queued = new Set<number>();

export const enqueueMealForEmbedding = (mealId: number): void => {
  queued.add(mealId);
};

export const drainQueue = (): readonly number[] => {
  const ids = [...queued];
  queued.clear();
  return ids;
};

export const queueSize = (): number => queued.size;

interface MealRow {
  id: number;
  fingerprint: string | null;
  name: string | null;
  label: string | null;
  ingredients_raw: string | null;
  allergens: string[] | null;
}

const buildPassage = (m: Readonly<MealRow>): string => {
  const lines = [
    m.name ?? "",
    `Wariant: ${m.label ?? ""}`,
    `Składniki: ${m.ingredients_raw ?? ""}`,
    `Alergeny: ${(m.allergens ?? []).join(", ")}`,
  ];
  while (lines.length > 0) {
    const last = lines.at(-1);
    if (
      last === "" ||
      last === "Wariant: " ||
      last === "Składniki: " ||
      last === "Alergeny: "
    ) {
      lines.pop();
    } else {
      break;
    }
  }
  return lines.join("\n");
};

/**
 * Embed the given meal_ids and insert into meal_embeddings. Idempotent — the
 * composite PK `(meal_id, embedded_fp)` collapses duplicate writes.
 *
 * If `ids` is empty, returns 0 without loading the model.
 */
export const embedMeals = async (ids: readonly number[]): Promise<number> => {
  if (ids.length === 0) {
    return 0;
  }
  // Pull all rows in one shot — small per-run sets (~tens of meals typical).
  const rows = await query<MealRow>(
    `SELECT id, fingerprint, name, label, ingredients_raw, allergens
       FROM meals
      WHERE id = ANY($1::bigint[])
      ORDER BY id`,
    [[...ids]]
  );
  if (rows.length === 0) {
    return 0;
  }
  // Skip meals that already have an embedding matching their current fp.
  const fpById = new Map(rows.map((r) => [r.id, r.fingerprint ?? ""] as const));
  const existing = await query<{ meal_id: number; embedded_fp: string }>(
    `SELECT meal_id, embedded_fp
       FROM current_meal_embeddings
      WHERE meal_id = ANY($1::bigint[])`,
    [rows.map((r) => r.id)]
  );
  const upToDate = new Set<number>();
  for (const e of existing) {
    if (e.embedded_fp === fpById.get(e.meal_id)) {
      upToDate.add(e.meal_id);
    }
  }
  const needWork = rows.filter((r) => !upToDate.has(r.id));
  if (needWork.length === 0) {
    return 0;
  }

  const embedder = await getEmbedder();
  let done = 0;

  for (let i = 0; i < needWork.length; i += BATCH_SIZE) {
    const slice = needWork.slice(i, i + BATCH_SIZE);
    const passages = slice.map(buildPassage);
    const vectors = await embedder.embedBatch(passages);
    for (let j = 0; j < slice.length; j += 1) {
      const row = slice[j];
      const vec = vectors[j];
      const fp = row.fingerprint ?? "";
      await query(
        `INSERT INTO meal_embeddings (meal_id, embedded_fp, embedding, embedded_at)
         VALUES ($1, $2, $3::vector, NOW())
         ON CONFLICT (meal_id, embedded_fp) DO NOTHING`,
        [row.id, fp, toPgVector(vec)]
      );
      done += 1;
    }
  }
  return done;
};

/**
 * Drain the queue and embed all currently-queued meal_ids. Invoked from
 * `scraper/index.ts` at end of run. Non-fatal: errors are caught upstream.
 */
export const flushEmbeddings = async (): Promise<number> => {
  const ids = drainQueue();
  if (ids.length === 0) {
    return 0;
  }
  console.log(`[embed] flushing ${ids.length} queued meal(s)...`);
  const t0 = Date.now();
  const done = await embedMeals(ids);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[embed] ✓ embedded ${done}/${ids.length} meal(s) in ${elapsed}s`
  );
  return done;
};
