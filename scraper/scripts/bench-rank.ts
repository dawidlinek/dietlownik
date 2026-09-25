/**
 * bench-rank: for each (model × query) compute ranking metrics, restricted
 * to a single (city, day) slice — matching how the production scoring query
 * actually works. Labels from off-slice meals are ignored even if present.
 *
 * Reads:
 *   - bench_queries
 *   - bench_labels             (filtered by labeler_model)
 *   - bench/vectors/<id>.bin   (one file per model, from bench-embed-all)
 *   - menu_items               (to enforce the city+day slice)
 *
 * Writes:
 *   - bench_runs               (one row per model × scope)
 *   - bench_run_per_query      (per-query breakdown)
 *
 *   BENCH_CITY=986283 BENCH_DAY=2026-05-20 npm run bench:rank
 *   # defaults: city=Wrocław (986283), day=busiest day in menu_items
 *   BENCH_MODELS=e5-large,mmlw-e5-large npm run bench:rank
 *   BENCH_LABELER=claude-sonnet-4-5 npm run bench:rank
 */

import "dotenv/config";
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";

import { query } from "../../lib/db.js";
import { CANDIDATES } from "./bench-candidates.js";
import type { Candidate } from "./bench-candidates.js";

const dir = import.meta.dirname;
const VECTORS_DIR = join(dir, "..", "..", "bench", "vectors");

const POSITIVE_THRESHOLD = Number.parseFloat(
  process.env.BENCH_POSITIVE_THRESHOLD ?? "7"
);
const LABELER = process.env.BENCH_LABELER ?? "claude-sonnet-4-5";
const CITY_ID = Number.parseInt(process.env.BENCH_CITY ?? "986283", 10);
const DAY_OVERRIDE = process.env.BENCH_DAY;

interface CacheData {
  readonly dim: number;
  readonly idToVec: ReadonlyMap<bigint, Float32Array>;
}

const loadCache = (path: string): CacheData => {
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(16);
    readSync(fd, header, 0, 16, 0);
    const magic = header.readUInt32LE(0);
    // 'BENC' = 0x42454E43 = 1_111_705_667
    if (magic !== 1_111_705_667) {
      throw new Error(`bad magic in ${path}: 0x${magic.toString(16)}`);
    }
    const count = header.readUInt32LE(8);
    const dim = header.readUInt32LE(12);

    const idBuf = Buffer.alloc(count * 8);
    readSync(fd, idBuf, 0, idBuf.length, 16);
    const ids = Array.from<bigint>({ length: count });
    for (let i = 0; i < count; i += 1) {
      ids[i] = idBuf.readBigInt64LE(i * 8);
    }

    const vecBytes = count * dim * 4;
    const vecBuf = Buffer.alloc(vecBytes);
    readSync(fd, vecBuf, 0, vecBytes, 16 + idBuf.length);

    const idToVec = new Map<bigint, Float32Array>();
    for (let i = 0; i < count; i += 1) {
      const offset = i * dim * 4;
      const vec = new Float32Array(dim);
      for (let j = 0; j < dim; j += 1) {
        vec[j] = vecBuf.readFloatLE(offset + j * 4);
      }
      idToVec.set(ids[i], vec);
    }
    return { dim, idToVec };
  } finally {
    closeSync(fd);
  }
};

const cosine = (
  // oxlint-disable-next-line typescript-eslint/prefer-readonly-parameter-types -- Float32Array has no true readonly variant in lib.es5.d.ts
  a: Float32Array,
  // oxlint-disable-next-line typescript-eslint/prefer-readonly-parameter-types -- Float32Array has no true readonly variant in lib.es5.d.ts
  b: Float32Array
): number => {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
  }
  return dot;
};

const averagePrecision = (
  sortedDesc: readonly Readonly<{ relevant: boolean }>[]
): number => {
  let hits = 0;
  let sumPrecision = 0;
  for (let i = 0; i < sortedDesc.length; i += 1) {
    if (sortedDesc[i].relevant) {
      hits += 1;
      sumPrecision += hits / (i + 1);
    }
  }
  return hits === 0 ? 0 : sumPrecision / hits;
};

const dcgFor = (
  sortedDesc: readonly Readonly<{ score: number }>[],
  k: number
): number => {
  let acc = 0;
  const limit = Math.min(k, sortedDesc.length);
  for (let i = 0; i < limit; i += 1) {
    const gain = 2 ** (sortedDesc[i].score / 10) - 1;
    acc += gain / Math.log2(i + 2);
  }
  return acc;
};

const ndcgAtK = (
  sortedDesc: readonly Readonly<{ score: number }>[],
  k: number
): number => {
  const dcg = dcgFor(sortedDesc, k);
  const idealSorted = [...sortedDesc].toSorted(
    (a: Readonly<{ score: number }>, b: Readonly<{ score: number }>) =>
      b.score - a.score
  );
  const ideal = dcgFor(idealSorted, k);
  return ideal === 0 ? 0 : dcg / ideal;
};

const recallAtK = (
  sortedDesc: readonly Readonly<{ relevant: boolean }>[],
  k: number,
  totalPositives: number
): number => {
  if (totalPositives === 0) {
    return 0;
  }
  const hits = sortedDesc
    .slice(0, k)
    .filter((r: Readonly<{ relevant: boolean }>) => r.relevant).length;
  return hits / totalPositives;
};

// AUROC via Mann–Whitney U / (n_pos * n_neg).
const auroc = (
  positives: readonly number[],
  negatives: readonly number[]
): number => {
  const m = positives.length;
  const n = negatives.length;
  if (m === 0 || n === 0) {
    return 0.5;
  }
  let count = 0;
  for (const p of positives) {
    for (const q of negatives) {
      if (p > q) {
        count += 1;
      } else if (p === q) {
        count += 0.5;
      }
    }
  }
  return count / (m * n);
};

interface QueryRow {
  readonly query_id: number;
  readonly query_text: string;
  readonly query_family: string;
}

interface LabelRow {
  readonly query_id: number;
  readonly meal_id: string;
  readonly score: string;
}

interface LabelEntry {
  readonly meal_id: bigint;
  readonly score: number;
}

interface Row {
  readonly meal_id: bigint;
  readonly score: number;
  readonly sim: number;
  readonly relevant: boolean;
}

interface PerQueryStat {
  readonly map: number;
  readonly ndcg10: number;
  readonly auroc: number;
  readonly r10: number;
  readonly r50: number;
}

interface PipelineOutput {
  readonly data: Float32Array;
  readonly dims: readonly number[];
}
type Pipeline = (input: string, opts: object) => Promise<PipelineOutput>;
interface TransformersModule {
  readonly pipeline: (task: string, model: string) => Promise<Pipeline>;
}

const isTransformersModule = (m: unknown): m is TransformersModule =>
  typeof m === "object" &&
  m !== null &&
  typeof (m as { pipeline?: unknown }).pipeline === "function";

const loadPipeline = async (c: Candidate): Promise<Pipeline> => {
  const mod: unknown = await import("@xenova/transformers");
  if (!isTransformersModule(mod)) {
    throw new Error("@xenova/transformers does not expose pipeline()");
  }
  return mod.pipeline("feature-extraction", c.model);
};

const mean = (xs: readonly number[]): number => {
  if (xs.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const x of xs) {
    sum += x;
  }
  return sum / xs.length;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const pickBusiestDay = async (cityId: number): Promise<string> => {
  const rows = await query<{ menu_date: string }>(
    `SELECT menu_date::text
       FROM menu_items
      WHERE city_id = $1
      GROUP BY menu_date
      ORDER BY COUNT(DISTINCT meal_id) DESC, menu_date DESC
      LIMIT 1`,
    [cityId]
  );
  if (rows.length === 0) {
    throw new Error(`no menu_items rows for city_id=${cityId}`);
  }
  return rows[0].menu_date;
};

const loadSliceMealIds = async (
  cityId: number,
  day: string
): Promise<Set<bigint>> => {
  const rows = await query<{ meal_id: string }>(
    `SELECT DISTINCT meal_id::text
       FROM menu_items
      WHERE city_id = $1 AND menu_date = $2`,
    [cityId, day]
  );
  return new Set(
    rows.map((r: Readonly<{ meal_id: string }>) => BigInt(r.meal_id))
  );
};

const buildRowsForQuery = (
  sliceLabels: readonly LabelEntry[],
  // oxlint-disable-next-line typescript-eslint/prefer-readonly-parameter-types -- Float32Array has no true readonly variant in lib.es5.d.ts
  qVec: Float32Array,
  // oxlint-disable-next-line typescript-eslint/prefer-readonly-parameter-types -- ReadonlyMap<_, Float32Array> still reports because value is mutable
  idToVec: ReadonlyMap<bigint, Float32Array>
): { rows: Row[]; missing: number } => {
  const rows: Row[] = [];
  let missing = 0;
  for (const lbl of sliceLabels) {
    const v = idToVec.get(lbl.meal_id);
    if (v === undefined) {
      missing += 1;
      continue;
    }
    const sim = cosine(qVec, v);
    rows.push({
      meal_id: lbl.meal_id,
      relevant: lbl.score >= POSITIVE_THRESHOLD,
      score: lbl.score,
      sim,
    });
  }
  return { missing, rows };
};

const evaluateModel = async (
  c: Candidate,
  queries: readonly QueryRow[],
  // oxlint-disable-next-line typescript-eslint/prefer-readonly-parameter-types -- ReadonlyMap value is readonly LabelEntry[]; reported anyway
  labelsByQuery: ReadonlyMap<number, readonly LabelEntry[]>,
  // oxlint-disable-next-line typescript-eslint/prefer-readonly-parameter-types -- ReadonlySet<bigint> is already immutable
  sliceMealIds: ReadonlySet<bigint>,
  cityId: number,
  day: string
): Promise<void> => {
  const cachePath = join(VECTORS_DIR, `${c.id}.bin`);
  if (!existsSync(cachePath)) {
    console.log(`  ${c.id}: no cache at ${cachePath} — skip`);
    return;
  }
  const cache = loadCache(cachePath);
  console.log(`  ${c.id}: cached ${cache.idToVec.size} meals × ${cache.dim}d`);

  const pipe = await loadPipeline(c);

  const runRows = await query<{ run_id: string }>(
    `INSERT INTO bench_runs
       (model_id, model_hf_id, embed_dim, passage_prefix, query_prefix,
        labeler_model, scope_city_id, scope_day, meal_count, query_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9, $10)
     RETURNING run_id::text`,
    [
      c.id,
      c.model,
      cache.dim,
      c.passagePrefix ?? null,
      c.queryPrefix ?? null,
      LABELER,
      cityId,
      day,
      sliceMealIds.size,
      queries.length,
    ]
  );
  const runId = runRows[0].run_id;

  const perQueryStats: PerQueryStat[] = [];

  for (const q of queries) {
    const labels = labelsByQuery.get(q.query_id);
    if (labels === undefined || labels.length === 0) {
      continue;
    }

    // Restrict labeled meals to the (city, day) slice — match production.
    const sliceLabels = labels.filter((l: LabelEntry) =>
      sliceMealIds.has(l.meal_id)
    );
    if (sliceLabels.length === 0) {
      continue;
    }

    const qText =
      c.queryPrefix === undefined
        ? q.query_text
        : `${c.queryPrefix}${q.query_text}`;
    const out = await pipe(qText, { normalize: true, pooling: "mean" });
    const qDim = out.dims.at(-1);
    if (qDim === undefined) {
      throw new Error(`query pipeline returned empty dims for ${c.id}`);
    }
    const qVec = new Float32Array(qDim);
    qVec.set(out.data.subarray(0, qVec.length));

    const { rows, missing } = buildRowsForQuery(
      sliceLabels,
      qVec,
      cache.idToVec
    );
    if (rows.length === 0) {
      continue;
    }

    rows.sort((a: Row, b: Row) => b.sim - a.sim);

    const positives = rows
      .filter((r: Row) => r.relevant)
      .map((r: Row) => r.sim);
    const negatives = rows
      .filter((r: Row) => !r.relevant)
      .map((r: Row) => r.sim);
    const totalPos = positives.length;

    const map = averagePrecision(rows);
    const ndcg10 = ndcgAtK(rows, 10);
    const r10 = recallAtK(rows, 10, totalPos);
    const r50 = recallAtK(rows, 50, totalPos);
    const auc = auroc(positives, negatives);

    perQueryStats.push({ auroc: auc, map, ndcg10, r10, r50 });

    await query(
      `INSERT INTO bench_run_per_query
         (run_id, query_id, query_family, pool_size, positives, map, ndcg_10, auroc, recall_10, recall_50)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        runId,
        q.query_id,
        q.query_family,
        rows.length,
        totalPos,
        map,
        ndcg10,
        auc,
        r10,
        r50,
      ]
    );

    if (missing > 0) {
      console.log(
        `    ${q.query_text.padEnd(28)} pool=${rows.length}(+${missing}miss) pos=${totalPos}  MAP=${map.toFixed(3)} NDCG@10=${ndcg10.toFixed(3)} AUROC=${auc.toFixed(3)}`
      );
    }
  }

  const meanMap = mean(perQueryStats.map((s: PerQueryStat) => s.map));
  const meanNdcg10 = mean(perQueryStats.map((s: PerQueryStat) => s.ndcg10));
  const meanAuc = mean(perQueryStats.map((s: PerQueryStat) => s.auroc));
  const meanR10 = mean(perQueryStats.map((s: PerQueryStat) => s.r10));
  const meanR50 = mean(perQueryStats.map((s: PerQueryStat) => s.r50));

  await query(
    `UPDATE bench_runs SET
       completed_at = NOW(),
       mean_map = $2, mean_ndcg_10 = $3, mean_auroc = $4,
       mean_recall_10 = $5, mean_recall_50 = $6
     WHERE run_id = $1::uuid`,
    [runId, meanMap, meanNdcg10, meanAuc, meanR10, meanR50]
  );

  console.log(
    `  ${c.id} ✓  MAP=${meanMap.toFixed(3)}  NDCG@10=${meanNdcg10.toFixed(3)}  AUROC=${meanAuc.toFixed(3)}  R@10=${meanR10.toFixed(3)}  R@50=${meanR50.toFixed(3)}`
  );
};

const main = async (): Promise<void> => {
  const day = DAY_OVERRIDE ?? (await pickBusiestDay(CITY_ID));

  const filter = process.env.BENCH_MODELS;
  const cachedIds = existsSync(VECTORS_DIR)
    ? new Set(
        readdirSync(VECTORS_DIR)
          .filter((f) => f.endsWith(".bin"))
          .map((f) => f.replace(/\.bin$/u, ""))
      )
    : new Set<string>();
  const selected = CANDIDATES.filter((c) => {
    if (!cachedIds.has(c.id)) {
      return false;
    }
    if (filter === undefined || filter === "") {
      return true;
    }
    return filter
      .split(",")
      .map((s) => s.trim())
      .includes(c.id);
  });

  if (selected.length === 0) {
    console.error("no cached models to evaluate. Run bench:embed-all first.");
    process.exit(1);
  }

  const sliceMealIds = await loadSliceMealIds(CITY_ID, day);
  console.log(
    `eval scope: city_id=${CITY_ID} day=${day}  →  ${sliceMealIds.size} meals on offer`
  );
  console.log(
    `labels from: ${LABELER}   positive threshold: ${POSITIVE_THRESHOLD}\n`
  );

  const queries = await query<QueryRow>(
    `SELECT query_id, query_text, query_family FROM bench_queries ORDER BY query_id`
  );

  const allLabels = await query<LabelRow>(
    `SELECT query_id, meal_id::text, score::text
       FROM bench_labels
      WHERE labeler_model = $1`,
    [LABELER]
  );
  const labelsByQuery = new Map<number, LabelEntry[]>();
  for (const r of allLabels) {
    const arr = labelsByQuery.get(r.query_id) ?? [];
    arr.push({
      meal_id: BigInt(r.meal_id),
      score: Number.parseFloat(r.score),
    });
    labelsByQuery.set(r.query_id, arr);
  }
  console.log(
    `${allLabels.length} total labels across ${labelsByQuery.size} queries`
  );

  // Pre-flight: warn if labels barely intersect the slice.
  let intersectTotal = 0;
  for (const arr of labelsByQuery.values()) {
    intersectTotal += arr.filter((l: LabelEntry) =>
      sliceMealIds.has(l.meal_id)
    ).length;
  }
  console.log(
    `  → ${intersectTotal} labels fall within the (city, day) slice\n`
  );
  if (intersectTotal === 0) {
    console.error(
      "no labeled meals are in the slice — did you bench:sample with the same BENCH_CITY/BENCH_DAY?"
    );
    process.exit(1);
  }

  for (const c of selected) {
    console.log(`▶ ${c.id} (${c.model})`);
    try {
      await evaluateModel(
        c,
        queries,
        labelsByQuery,
        sliceMealIds,
        CITY_ID,
        day
      );
    } catch (error) {
      console.error(`  ✗ ${c.id} failed: ${errorMessage(error)}`);
    }
    console.log();
  }
};

try {
  await main();
  process.exit(0);
} catch (error) {
  console.error("bench-rank failed:", error);
  process.exit(1);
}
