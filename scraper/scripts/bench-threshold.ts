/**
 * bench-threshold: sweep cosine-similarity thresholds for one cached model
 * against the labeled set, find the precision/recall sweet spot.
 *
 *   BENCH_MODELS=e5-small npm run bench:threshold
 *
 * Per labeler, computes for τ ∈ {0.50, 0.51, ..., 0.95}:
 *   - precision: of meals predicted relevant (sim≥τ), what fraction is truly
 *                relevant (label≥7)?
 *   - recall:    of truly-relevant meals, what fraction did we predict?
 *   - F1:        harmonic mean of precision and recall
 *
 * Reports:
 *   - τ that maximizes F1 (the "balanced" threshold)
 *   - τ at which precision first crosses 0.80, 0.90 (the "conservative" picks)
 *   - the full curve as a small ASCII table
 */

import "dotenv/config";
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

import { query } from "../../lib/db.js";
import { CANDIDATES } from "./bench-candidates.js";

const VECTORS_DIR = join(import.meta.dirname, "..", "..", "bench", "vectors");
const POSITIVE = Number.parseFloat(process.env.BENCH_POSITIVE_THRESHOLD ?? "7");
const CITY_ID = Number.parseInt(process.env.BENCH_CITY ?? "986283", 10);
const DAY = process.env.BENCH_DAY ?? "2026-05-20";

const loadCache = (path: string): Map<bigint, Float32Array> => {
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(16);
    readSync(fd, header, 0, 16, 0);
    // Magic matches the one bench-embed-all.ts writes (1_111_705_667).
    if (header.readUInt32LE(0) !== 1_111_705_667) {
      throw new Error(`bad magic in ${path}`);
    }
    const count = header.readUInt32LE(8);
    const dim = header.readUInt32LE(12);
    const idBuf = Buffer.alloc(count * 8);
    readSync(fd, idBuf, 0, idBuf.length, 16);
    const vecBytes = count * dim * 4;
    const vecBuf = Buffer.alloc(vecBytes);
    readSync(fd, vecBuf, 0, vecBytes, 16 + idBuf.length);
    const map = new Map<bigint, Float32Array>();
    for (let i = 0; i < count; i += 1) {
      const id = idBuf.readBigInt64LE(i * 8);
      const vec = new Float32Array(dim);
      const off = i * dim * 4;
      for (let j = 0; j < dim; j += 1) {
        vec[j] = vecBuf.readFloatLE(off + j * 4);
      }
      map.set(id, vec);
    }
    return map;
  } finally {
    closeSync(fd);
  }
};

// oxlint-disable-next-line typescript-eslint/prefer-readonly-parameter-types -- Float32Array has no true readonly variant in lib.es5.d.ts
const cosine = (a: Float32Array, b: Float32Array): number => {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
  }
  return dot;
};

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

interface SweepRow {
  readonly tau: number;
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
}

interface Pair {
  readonly sim: number;
  readonly relevant: boolean;
}

const sweep = (
  pairs: readonly Pair[]
): { readonly rows: readonly SweepRow[]; readonly totalPos: number } => {
  const totalPos = pairs.filter((p) => p.relevant).length;
  const rows: SweepRow[] = [];
  for (let t = 50; t <= 95; t += 1) {
    const tau = t / 100;
    let tp = 0;
    let fp = 0;
    for (const p of pairs) {
      if (p.sim >= tau) {
        if (p.relevant) {
          tp += 1;
        } else {
          fp += 1;
        }
      }
    }
    const fn = totalPos - tp;
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = totalPos === 0 ? 0 : tp / totalPos;
    const f1 =
      precision + recall === 0
        ? 0
        : (2 * precision * recall) / (precision + recall);
    rows.push({ f1, fn, fp, precision, recall, tau, tp });
  }
  return { rows, totalPos };
};

const printSweep = (labeler: string, pairs: readonly Pair[]): void => {
  const line = "═".repeat(70);
  console.log(line);
  console.log(
    `labeler = ${labeler}   pairs = ${pairs.length}   positives = ${pairs.filter((p) => p.relevant).length}`
  );
  console.log(line);
  const { rows, totalPos } = sweep(pairs);
  const [bestF1] = [...rows].toSorted((a, b) => b.f1 - a.f1);
  const p80 = rows.find((r) => r.precision >= 0.8);
  const p90 = rows.find((r) => r.precision >= 0.9);

  console.log(`\nKey thresholds:`);
  if (bestF1 !== undefined) {
    console.log(
      `  max-F1     τ=${bestF1.tau.toFixed(2)}  P=${(bestF1.precision * 100).toFixed(0)}%  R=${(bestF1.recall * 100).toFixed(0)}%  F1=${bestF1.f1.toFixed(3)}`
    );
  }
  if (p80 !== undefined) {
    console.log(
      `  P≥0.80     τ=${p80.tau.toFixed(2)}  P=${(p80.precision * 100).toFixed(0)}%  R=${(p80.recall * 100).toFixed(0)}%  F1=${p80.f1.toFixed(3)}`
    );
  }
  if (p90 !== undefined) {
    console.log(
      `  P≥0.90     τ=${p90.tau.toFixed(2)}  P=${(p90.precision * 100).toFixed(0)}%  R=${(p90.recall * 100).toFixed(0)}%  F1=${p90.f1.toFixed(3)}`
    );
  }
  if (totalPos === 0) {
    console.log(`  (no positives — recall undefined)`);
  }

  console.log(`\nFull curve (every 5 hundredths shown):`);
  console.log(`  τ      TP    FP    FN    P       R       F1`);
  for (let i = 0; i < rows.length; i += 1) {
    if (i % 5 !== 0 && i !== rows.length - 1) {
      continue;
    }
    const r = rows[i];
    console.log(
      `  ${r.tau.toFixed(2)}   ${String(r.tp).padStart(4)}  ${String(r.fp).padStart(4)}  ${String(r.fn).padStart(4)}  ${(r.precision * 100).toFixed(0).padStart(3)}%    ${(r.recall * 100).toFixed(0).padStart(3)}%    ${r.f1.toFixed(3)}`
    );
  }
  console.log();
};

const main = async (): Promise<void> => {
  const filter = process.env.BENCH_MODELS ?? "e5-small";
  const candidate = CANDIDATES.find((c) => c.id === filter);
  if (!candidate) {
    console.error(
      `unknown model id: ${filter}. Available: ${CANDIDATES.map((c) => c.id).join(",")}`
    );
    process.exit(1);
  }
  const cachePath = join(VECTORS_DIR, `${candidate.id}.bin`);
  if (!existsSync(cachePath)) {
    console.error(
      `no vector cache for ${candidate.id} — run bench:embed-all first`
    );
    process.exit(1);
  }

  console.log(`▶ ${candidate.id} (${candidate.model})`);
  console.log(
    `scope: city_id=${CITY_ID} day=${DAY}   positive_threshold=${POSITIVE}\n`
  );

  // 1. Load meal vectors + slice meal_ids
  const meals = loadCache(cachePath);
  const sliceRows = await query<{ meal_id: string }>(
    `SELECT DISTINCT meal_id::text FROM menu_items
      WHERE city_id=$1 AND menu_date=$2`,
    [CITY_ID, DAY]
  );
  // oxlint-disable-next-line typescript-eslint/prefer-readonly-parameter-types -- query<T>() row type is mutable by design
  const slice = new Set(sliceRows.map((r) => BigInt(r.meal_id)));
  console.log(
    `loaded ${meals.size} cached meal vectors; ${slice.size} are in (city,day) slice`
  );

  // 2. Pull all labels in the slice, with the query text
  const labelRows = await query<{
    labeler: string;
    query_text: string;
    meal_id: string;
    score: string;
  }>(
    `SELECT bl.labeler_model AS labeler, q.query_text, bl.meal_id::text, bl.score::text
       FROM bench_labels bl
       JOIN bench_queries q ON q.query_id = bl.query_id
      WHERE bl.meal_id IN (
              SELECT DISTINCT meal_id FROM menu_items
               WHERE city_id=$1 AND menu_date=$2
            )`,
    [CITY_ID, DAY]
  );
  console.log(
    // oxlint-disable-next-line typescript-eslint/prefer-readonly-parameter-types -- query<T>() row type is mutable by design
    `${labelRows.length} labels in slice across ${new Set(labelRows.map((r) => r.labeler)).size} labelers\n`
  );

  // 3. Embed every unique query text once with the model's queryPrefix
  const mod: unknown = await import("@xenova/transformers");
  if (!isTransformersModule(mod)) {
    throw new Error("@xenova/transformers does not expose pipeline()");
  }
  const pipe = await mod.pipeline("feature-extraction", candidate.model);
  // oxlint-disable-next-line typescript-eslint/prefer-readonly-parameter-types -- query<T>() row type is mutable by design
  const uniqQueries = [...new Set(labelRows.map((r) => r.query_text))];
  console.log(`embedding ${uniqQueries.length} unique queries...`);
  const qVec = new Map<string, Float32Array>();
  for (const qt of uniqQueries) {
    const text =
      candidate.queryPrefix === undefined
        ? qt
        : `${candidate.queryPrefix}${qt}`;
    const out = await pipe(text, { normalize: true, pooling: "mean" });
    const dim = out.dims.at(-1);
    if (dim === undefined) {
      throw new Error("empty dims");
    }
    const v = new Float32Array(dim);
    v.set(out.data.subarray(0, dim));
    qVec.set(qt, v);
  }

  // 4. For each labeler separately, build sim/label pairs and sweep thresholds
  const byLabeler = new Map<string, Pair[]>();
  for (const r of labelRows) {
    const mv = meals.get(BigInt(r.meal_id));
    const qv = qVec.get(r.query_text);
    if (mv === undefined || qv === undefined) {
      continue;
    }
    const sim = cosine(qv, mv);
    const relevant = Number.parseFloat(r.score) >= POSITIVE;
    const existing = byLabeler.get(r.labeler);
    if (existing === undefined) {
      byLabeler.set(r.labeler, [{ relevant, sim }]);
    } else {
      existing.push({ relevant, sim });
    }
  }

  for (const [labeler, pairs] of [...byLabeler.entries()].toSorted(
    // oxlint-disable-next-line typescript-eslint/prefer-readonly-parameter-types -- Map.entries() tuple type is mutable
    (a, b) => a[0].localeCompare(b[0])
  )) {
    printSweep(labeler, pairs);
  }
};

try {
  await main();
  process.exit(0);
} catch (error: unknown) {
  console.error(
    "bench-threshold failed:",
    error instanceof Error ? error.message : error
  );
  process.exit(1);
}
