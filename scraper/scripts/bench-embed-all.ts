/**
 * bench-embed-all: for every CANDIDATE model, embed every meal in the corpus
 * and cache the vectors to disk (packed binary, one file per model).
 *
 * Run BEFORE bench-rank. Idempotent — skips models whose cache file already
 * has the right meal count and dim.
 *
 *   npm run bench:embed-all                                 # all candidates
 *   BENCH_MODELS=e5-large,mmlw-e5-large npm run bench:embed-all   # subset
 *
 * Output: bench/vectors/<model_id>.bin
 *   header (little-endian):
 *     uint32  magic = 0x42454E43 ("BENC")
 *     uint32  version = 1
 *     uint32  meal_count
 *     uint32  dim
 *   then meal_count × int64  meal_ids
 *   then meal_count × dim × float32  vectors (row-major, L2-normalised)
 */

import "dotenv/config";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import { query } from "../../lib/db.js";
import { buildPassage } from "../meal-passage.js";
// Candidates moved to bench-candidates.ts to keep this module's `await main()`
// from running when another script imports the registry (it would otherwise
// embed the corpus + exit before the caller's main runs).
import { CANDIDATES } from "./bench-candidates.js";
import type { Candidate } from "./bench-candidates.js";

export { CANDIDATES };
export type { Candidate };

const dir = import.meta.dirname;
const VECTORS_DIR = join(dir, "..", "..", "bench", "vectors");

// 'BENC' as a 32-bit little-endian magic number (0x42454E43).
const MAGIC = 1_111_705_667;
// 2 = passages built by scraper/meal-passage.ts (the production format) from
// the dish's latest variant. Bumping it invalidates v1 caches, which used a
// bench-local passage format; readers ignore this field.
const VERSION = 2;
const BATCH = 16;

// One row per dish: meals.name + the content of its latest variant
// (meal_latest_variant). Vectors stay keyed by meal_id because bench labels
// are per meal.
interface MealRow {
  readonly id: string;
  readonly name: string;
  readonly label: string | null;
  readonly ingredients_raw: string | null;
  readonly allergens: readonly string[] | null;
}

const ensureDir = (path: string): void => {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
};

const cacheValid = (
  path: string,
  expectedCount: number
): { dim: number } | null => {
  if (!existsSync(path)) {
    return null;
  }
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(16);
    const n = readSync(fd, header, 0, 16, 0);
    if (n < 16) {
      return null;
    }
    if (header.readUInt32LE(0) !== MAGIC) {
      return null;
    }
    if (header.readUInt32LE(4) !== VERSION) {
      return null;
    }
    const count = header.readUInt32LE(8);
    const dim = header.readUInt32LE(12);
    if (count !== expectedCount) {
      return null;
    }
    return { dim };
  } finally {
    closeSync(fd);
  }
};

const writeCache = (
  path: string,
  ids: readonly bigint[],
  // oxlint-disable-next-line typescript-eslint/prefer-readonly-parameter-types -- Float32Array has no true readonly variant in lib.es5.d.ts
  vectors: readonly Readonly<Float32Array>[]
): void => {
  const fd = openSync(path, "w");
  try {
    const dim = vectors[0]?.length ?? 0;
    const header = Buffer.alloc(16);
    header.writeUInt32LE(MAGIC, 0);
    header.writeUInt32LE(VERSION, 4);
    header.writeUInt32LE(ids.length, 8);
    header.writeUInt32LE(dim, 12);
    writeSync(fd, header);

    const idBuf = Buffer.alloc(ids.length * 8);
    for (let i = 0; i < ids.length; i += 1) {
      idBuf.writeBigInt64LE(ids[i], i * 8);
    }
    writeSync(fd, idBuf);

    for (const v of vectors) {
      writeSync(fd, Buffer.from(v.buffer, v.byteOffset, v.byteLength));
    }
  } finally {
    closeSync(fd);
  }
};

interface PipelineOutput {
  readonly data: Float32Array;
  readonly dims: readonly number[];
}
type Pipeline = (
  input: readonly string[],
  opts: object
) => Promise<PipelineOutput>;
interface TransformersModule {
  readonly pipeline: (
    task: string,
    model: string,
    opts?: object
  ) => Promise<Pipeline>;
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
  return mod.pipeline("feature-extraction", c.model, {
    quantized: c.quantized,
  });
};

const embedAllForModel = async (
  c: Candidate,
  meals: readonly Readonly<MealRow>[]
): Promise<void> => {
  const cachePath = join(VECTORS_DIR, `${c.id}.bin`);
  const valid = cacheValid(cachePath, meals.length);
  if (valid !== null) {
    console.log(
      `  ${c.id}: cache valid (${meals.length} × ${valid.dim}) — skip`
    );
    return;
  }

  const t0 = Date.now();
  const pipe = await loadPipeline(c);
  const loadSec = ((Date.now() - t0) / 1000).toFixed(1);

  const ids: bigint[] = [];
  const vectors: Float32Array[] = [];
  let count = 0;
  const inferStart = Date.now();

  for (let i = 0; i < meals.length; i += BATCH) {
    const slice = meals.slice(i, i + BATCH);
    const texts = slice.map((m: Readonly<MealRow>) => {
      const p = buildPassage(m);
      return c.passagePrefix === undefined ? p : `${c.passagePrefix}${p}`;
    });
    const out = await pipe(texts, { normalize: true, pooling: "mean" });
    const dim = out.dims.at(-1);
    if (dim === undefined) {
      throw new Error(`pipeline returned empty dims for ${c.id}`);
    }
    for (let j = 0; j < slice.length; j += 1) {
      ids.push(BigInt(slice[j].id));
      const vec = new Float32Array(dim);
      vec.set(out.data.subarray(j * dim, (j + 1) * dim));
      vectors.push(vec);
    }
    count += slice.length;
    if ((i / BATCH) % 50 === 0) {
      const rate = count / ((Date.now() - inferStart) / 1000);
      console.log(
        `    ${count}/${meals.length}  (${rate.toFixed(1)} meals/sec)`
      );
    }
  }

  ensureDir(VECTORS_DIR);
  writeCache(cachePath, ids, vectors);

  const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `  ${c.id}: ${meals.length} meals × ${vectors[0].length}d in ${totalSec}s (load=${loadSec}s)  → ${cachePath}`
  );
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

const main = async (): Promise<void> => {
  const filter = process.env.BENCH_MODELS;
  const selected =
    filter === undefined || filter === ""
      ? CANDIDATES
      : CANDIDATES.filter((c) =>
          filter
            .split(",")
            .map((s) => s.trim())
            .includes(c.id)
        );

  if (selected.length === 0) {
    console.error("no models selected");
    process.exit(1);
  }

  // ── Slice scope (matches bench-sample / bench-rank) ──────────────────────
  // If BENCH_CITY + BENCH_DAY (or auto-picked busiest) are set with
  // BENCH_SLICE_ONLY=1, restrict the embed corpus to meals on offer in that
  // (city, day). This is the bench's actual scoring domain — embedding more
  // is wasted work.
  const sliceOnly = process.env.BENCH_SLICE_ONLY === "1";
  let meals: readonly MealRow[];

  if (sliceOnly) {
    const cityId = Number.parseInt(process.env.BENCH_CITY ?? "986283", 10);
    const day = process.env.BENCH_DAY ?? (await pickBusiestDay(cityId));
    console.log(
      `slice mode: city_id=${cityId} day=${day} — only meals on offer in this (city,day)`
    );
    meals = await query<MealRow>(
      `SELECT m.id::text, m.name, lv.label, lv.ingredients_raw, lv.allergens
         FROM meals m
         LEFT JOIN meal_latest_variant lv ON lv.meal_id = m.id
        WHERE m.id IN (
                SELECT DISTINCT meal_id
                  FROM menu_items
                 WHERE city_id = $1 AND menu_date = $2
              )
        ORDER BY m.id`,
      [cityId, day]
    );
  } else {
    meals = await query<MealRow>(
      `SELECT m.id::text, m.name, lv.label, lv.ingredients_raw, lv.allergens
         FROM meals m
         LEFT JOIN meal_latest_variant lv ON lv.meal_id = m.id
        ORDER BY m.id`
    );
  }
  const scopeNote = sliceOnly ? " (slice-only)" : " (full corpus)";
  console.log(
    `embedding ${meals.length} meals for ${selected.length} model(s)${scopeNote}`
  );

  for (const c of selected) {
    console.log(`\n▶ ${c.id} (${c.model})`);
    try {
      await embedAllForModel(c, meals);
    } catch (error) {
      console.error(`  ✗ ${c.id} failed: ${errorMessage(error)}`);
    }
  }
};

try {
  await main();
  process.exit(0);
} catch (error) {
  console.error("bench-embed-all failed:", error);
  process.exit(1);
}
