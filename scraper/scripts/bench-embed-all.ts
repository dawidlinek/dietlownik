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

const dir = import.meta.dirname;
const VECTORS_DIR = join(dir, "..", "..", "bench", "vectors");

// 'BENC' as a 32-bit little-endian magic number (0x42454E43).
const MAGIC = 1_111_705_667;
const VERSION = 1;
const BATCH = 16;

export interface Candidate {
  readonly id: string;
  readonly model: string;
  /** Prefix prepended to MEAL text before embedding. */
  readonly passagePrefix?: string;
  /** Prefix prepended to QUERY text at retrieval time (used by bench-rank). */
  readonly queryPrefix?: string;
  readonly quantized?: boolean;
}

// Models we have ONNX exports for via @xenova/transformers. Polish-specific
// models (mmlw, silver-retriever, snowflake-arctic) need their own ONNX
// export step before they can be added here — see bench/README.md.
//
// The e5 family was trained with an asymmetric convention: 'passage: ' for
// indexed documents, 'query: ' for searches. Bench-rank uses queryPrefix; this
// script uses passagePrefix.
export const CANDIDATES: readonly Candidate[] = [
  { id: "bge-m3", model: "Xenova/bge-m3" },
  {
    id: "e5-small",
    model: "Xenova/multilingual-e5-small",
    passagePrefix: "passage: ",
    queryPrefix: "query: ",
  },
  {
    id: "e5-base",
    model: "Xenova/multilingual-e5-base",
    passagePrefix: "passage: ",
    queryPrefix: "query: ",
  },
  {
    id: "e5-large",
    model: "Xenova/multilingual-e5-large",
    passagePrefix: "passage: ",
    queryPrefix: "query: ",
  },
  { id: "minilm-multi", model: "Xenova/paraphrase-multilingual-MiniLM-L12-v2" },
  { id: "mpnet-multi", model: "Xenova/paraphrase-multilingual-mpnet-base-v2" },
  { id: "labse", model: "Xenova/LaBSE" },
];

interface MealRow {
  readonly id: string;
  readonly name: string;
  readonly label: string | null;
  readonly ingredients_raw: string | null;
  readonly allergens: readonly string[] | null;
}

const buildPassage = (m: Readonly<MealRow>): string => {
  const lines = [
    m.name,
    m.label !== null && m.label !== "" ? `Wariant: ${m.label}` : "",
    m.ingredients_raw !== null && m.ingredients_raw !== ""
      ? `Składniki: ${m.ingredients_raw}`
      : "",
    m.allergens && m.allergens.length > 0
      ? `Alergeny: ${m.allergens.join(", ")}`
      : "",
  ];
  return lines.filter((l) => l.length > 0).join("\n");
};

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

  console.log(`embedding all meals for ${selected.length} model(s)`);

  const meals = await query<MealRow>(
    `SELECT id::text, name, label, ingredients_raw, allergens
       FROM meals
      ORDER BY id`
  );
  console.log(`corpus: ${meals.length} meals`);

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
