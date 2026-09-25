// Per-run embedding queue + flush helper.
//
// During a scrape run, `menus.ts` calls `enqueueVariantForEmbedding(id)` for
// every meal variant it inserted (a content never seen before). At end of
// run, `scraper/index.ts` invokes `flushEmbeddings()`, which embeds them into
// `variant_embeddings`. Variants are immutable, so each needs exactly one
// vector; `embedVariants` skips any that already have one at the current
// PASSAGE_VERSION. Errors are non-fatal — a stale model or unreachable HF
// cache must not break the scrape.

import { query } from "../lib/db.js";
import { getEmbedder, toPgVector } from "../lib/embeddings.js";
import { buildPassage, PASSAGE_VERSION } from "./meal-passage.js";

const BATCH_SIZE = 16;

// Module-level queue. Scraper is single-process; this is shared state per run.
const queued = new Set<number>();

export const enqueueVariantForEmbedding = (variantId: number): void => {
  queued.add(variantId);
};

export const drainQueue = (): readonly number[] => {
  const ids = [...queued];
  queued.clear();
  return ids;
};

export const queueSize = (): number => queued.size;

interface VariantRow {
  readonly id: string;
  readonly name: string | null;
  readonly label: string | null;
  readonly ingredients_raw: string | null;
  readonly allergens: readonly string[] | null;
}

/**
 * Embed the given variant ids into variant_embeddings. Idempotent: variants
 * already embedded at the current PASSAGE_VERSION are skipped, older ones
 * are overwritten.
 *
 * If `ids` is empty, returns 0 without loading the model.
 */
export const embedVariants = async (
  ids: readonly number[],
  onBatch?: (done: number, total: number) => void
): Promise<number> => {
  if (ids.length === 0) {
    return 0;
  }
  const rows = await query<VariantRow>(
    `SELECT v.id, m.name, v.label, v.ingredients_raw, v.allergens
       FROM meal_variants v
       JOIN meals m ON m.id = v.meal_id
       LEFT JOIN variant_embeddings e
         ON e.variant_id = v.id AND e.passage_version >= $2
      WHERE v.id = ANY($1::bigint[])
        AND e.variant_id IS NULL
      ORDER BY v.id`,
    [[...ids], PASSAGE_VERSION]
  );
  if (rows.length === 0) {
    return 0;
  }

  const embedder = await getEmbedder();
  let done = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const slice = rows.slice(i, i + BATCH_SIZE);
    const vectors = await embedder.embedBatch(slice.map(buildPassage));
    const pgVectors: string[] = [];
    for (const v of vectors) {
      pgVectors.push(toPgVector(v));
    }
    await query(
      `INSERT INTO variant_embeddings (variant_id, passage_version, embedding, embedded_at)
       SELECT id, $2, vec::vector, NOW()
       FROM UNNEST($1::bigint[], $3::text[]) AS t(id, vec)
       ON CONFLICT (variant_id) DO UPDATE SET
         passage_version = EXCLUDED.passage_version,
         embedding       = EXCLUDED.embedding,
         embedded_at     = EXCLUDED.embedded_at`,
      [slice.map((r) => r.id), PASSAGE_VERSION, pgVectors]
    );
    done += slice.length;
    onBatch?.(done, rows.length);
  }
  return done;
};

/**
 * Drain the queue and embed all currently-queued variants, plus any variant
 * on a current or upcoming menu that still has no vector. The second part
 * matters because variants are content-addressed: a dish that rotates back
 * with the same content reuses its old variant, which is never queued (it
 * isn't new) and may predate embedding. Ranking only searches upcoming days,
 * so this keeps search complete without backfilling all history. Invoked from
 * `scraper/index.ts` at end of run. Non-fatal: errors are caught upstream.
 */
export const flushEmbeddings = async (): Promise<number> => {
  const upcoming = await query<{ variant_id: string }>(
    `SELECT DISTINCT mi.variant_id
       FROM menu_items mi
       LEFT JOIN variant_embeddings e
         ON e.variant_id = mi.variant_id AND e.passage_version >= $1
      WHERE mi.closed_at IS NULL
        AND mi.menu_date >= CURRENT_DATE
        AND mi.variant_id IS NOT NULL
        AND e.variant_id IS NULL`,
    [PASSAGE_VERSION]
  );
  const ids = [
    ...new Set([
      ...drainQueue(),
      ...upcoming.map((r: Readonly<{ variant_id: string }>) =>
        Number(r.variant_id)
      ),
    ]),
  ];
  if (ids.length === 0) {
    return 0;
  }
  console.log(`[embed] flushing ${ids.length} queued variant(s)...`);
  const t0 = Date.now();
  const done = await embedVariants(ids);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[embed] ✓ embedded ${done}/${ids.length} variant(s) in ${elapsed}s`
  );
  return done;
};
