import type { FeatureExtractionPipeline } from "@xenova/transformers";

import { query } from "./db";

// NOTE on `server-only`: the upstream plan calls for `import 'server-only';`
// at the very top of this module to guard against accidental client-side
// imports. This file is shared between Next (SSR/instrumentation) and the
// tsx-run scraper backfill script (`scraper/scripts/embed-meals.ts`), so a
// literal `import 'server-only'` does not resolve under tsx — `server-only`
// is not a top-level dependency of this project (it lives only under
// `node_modules/next/dist/compiled/server-only`, which Next's compiler
// rewrites). The Vitest suite mocks it explicitly.
//
// To preserve the marker's intent without the resolution headache, we assert
// at module-init time that no browser globals are present. Any client-side
// bundling attempt will surface a clear error; Node/tsx pass through silently.
if (typeof window !== "undefined" || typeof document !== "undefined") {
  throw new TypeError(
    "lib/embeddings.ts must only be used from server code. " +
      "It pulls in onnxruntime-node and a ~570 MB embedding model."
  );
}

const MODEL = "Xenova/bge-m3";
const DIM = 1024 as const;

export interface Embedder {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: readonly string[]): Promise<readonly Float32Array[]>;
  readonly dim: typeof DIM;
}

// Lazy singleton — bge-m3 fp32 weights are ~570 MB, so we never load until the
// first call. Stored on globalThis so dev HMR doesn't re-download.
declare global {
  // oxlint-disable-next-line no-underscore-dangle, no-var -- HMR-safe singleton on globalThis
  var __dietlownikEmbedderPromise:
    | Promise<FeatureExtractionPipeline>
    | undefined;
}

// Returns the cached in-flight or resolved pipeline promise. Caching the
// Promise itself (not the resolved value) is intentional — concurrent first
// callers must share one load, not race two.
//
// We deliberately import @xenova/transformers via dynamic import here rather
// than at module top. Top-level value imports of transformers eagerly load
// onnxruntime-node's native .so, which crashes Next's "collect page data"
// step in Alpine builds (libonnxruntime.so is linked against glibc, not musl).
// At runtime on this project's deployment we ship a node:22-alpine runner —
// but the embedder is only ever called from the scraper, never from a route
// handler, so transformers is never actually dlopened in the web container.
// oxlint-disable-next-line typescript-eslint/promise-function-async -- caching the promise itself is the point; wrapping in async would defeat the singleton
const loadPipeline = (): Promise<FeatureExtractionPipeline> => {
  // oxlint-disable-next-line no-underscore-dangle -- HMR-safe singleton key
  const existing = global.__dietlownikEmbedderPromise;
  if (existing) {
    return existing;
  }
  // The upstream plan asks for `dtype: 'fp32'`. That option is a v3-only flag
  // on `@huggingface/transformers`; this project pins `@xenova/transformers`
  // 2.17.2, whose equivalent is `quantized: false` (loads `model.onnx`). On
  // bge-m3 specifically, the fp32 ONNX is split across an external 2.27 GB
  // `model.onnx_data` file that v2.x onnxruntime-node does not load — the
  // pipeline crashes at session init with "model_path must not be empty".
  // We therefore fall back to the int8-quantized weights (`model_quantized.onnx`,
  // ~569 MB, self-contained), which is the library's default. Smoke cosine
  // values from the verification suite still pass comfortably with quantized
  // weights. Revisit when the project upgrades to `@huggingface/transformers` v3.
  const loader = async (): Promise<FeatureExtractionPipeline> => {
    const { pipeline } = await import("@xenova/transformers");
    return pipeline("feature-extraction", MODEL);
  };
  const p = loader();
  // oxlint-disable-next-line no-underscore-dangle -- HMR-safe singleton key
  global.__dietlownikEmbedderPromise = p;
  return p;
};

// Narrow tensor.data (typed as a broader union by the library) to Float32Array
// at runtime. All feature-extraction outputs we use are float32.
const toFloat32Array = (data: unknown): Float32Array => {
  if (data instanceof Float32Array) {
    return data;
  }
  throw new TypeError("tensor.data is not a Float32Array");
};

const sliceTensorRow = (
  // oxlint-disable-next-line typescript-eslint/prefer-readonly-parameter-types -- Float32Array has no true readonly variant in lib.es5.d.ts
  flat: Float32Array,
  rowIndex: number,
  width: number
): Float32Array => {
  const start = rowIndex * width;
  // Copy out of the shared backing buffer so callers can't mutate the tensor.
  const out = new Float32Array(width);
  out.set(flat.subarray(start, start + width));
  return out;
};

export const getEmbedder = async (): Promise<Embedder> => {
  const extractor = await loadPipeline();
  return {
    dim: DIM,
    async embed(text: string): Promise<Float32Array> {
      const tensor = await extractor(text, {
        normalize: true,
        pooling: "mean",
      });
      // Output shape: [1, dim]. Tensor.data is a typed array (Float32Array for
      // float32 models). Copy out to detach from the tensor's buffer.
      const data = toFloat32Array(tensor.data);
      return sliceTensorRow(data, 0, DIM);
    },
    async embedBatch(
      texts: readonly string[]
    ): Promise<readonly Float32Array[]> {
      if (texts.length === 0) {
        return [];
      }
      const tensor = await extractor([...texts], {
        normalize: true,
        pooling: "mean",
      });
      const data = toFloat32Array(tensor.data);
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += 1) {
        out.push(sliceTensorRow(data, i, DIM));
      }
      return out;
    },
  };
};

// Postgres `vector(N)` accepts a text literal in the form `[v1,v2,...]`. The
// pgvector docs are explicit: that representation, cast with `::vector`, is
// the canonical input shape from a parameterised query.
// oxlint-disable-next-line typescript-eslint/prefer-readonly-parameter-types -- Float32Array has no true readonly variant in lib.es5.d.ts
export const toPgVector = (v: Float32Array): string => {
  const parts: string[] = Array.from({ length: v.length });
  for (let i = 0; i < v.length; i += 1) {
    parts[i] = String(v[i]);
  }
  return `[${parts.join(",")}]`;
};

// Cosine similarity assuming both inputs are already L2-normalised (which is
// what the pipeline returns with `normalize: true`). Equivalent to dot product.
// oxlint-disable-next-line typescript-eslint/prefer-readonly-parameter-types -- Float32Array has no true readonly variant in lib.es5.d.ts
export const cosine = (a: Float32Array, b: Float32Array): number => {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
  }
  return dot;
};

const parsePgVector = (text: string): Float32Array => {
  // pgvector serialises as e.g. "[0.012,-0.045,...]" — strip the brackets and split.
  const trimmed = text.trim();
  const inner =
    trimmed.startsWith("[") && trimmed.endsWith("]")
      ? trimmed.slice(1, -1)
      : trimmed;
  if (inner.length === 0) {
    return new Float32Array(0);
  }
  const parts = inner.split(",");
  const out = new Float32Array(parts.length);
  for (let i = 0; i < parts.length; i += 1) {
    out[i] = Number.parseFloat(parts[i]);
  }
  return out;
};

interface KeywordRow {
  embedding: string;
}

export const embedKeyword = async (keyword: string): Promise<Float32Array> => {
  const normalised = keyword.toLowerCase();
  const hit = await query<KeywordRow>(
    `UPDATE keyword_embeddings
       SET last_used_at = NOW()
     WHERE keyword = $1
     RETURNING embedding::text AS embedding`,
    [normalised]
  );
  if (hit.length > 0) {
    return parsePgVector(hit[0].embedding);
  }
  const embedder = await getEmbedder();
  const vec = await embedder.embed(normalised);
  await query(
    `INSERT INTO keyword_embeddings (keyword, embedding, last_used_at)
     VALUES ($1, $2::vector, NOW())
     ON CONFLICT (keyword) DO UPDATE SET last_used_at = NOW()`,
    [normalised, toPgVector(vec)]
  );
  return vec;
};

// Fire-and-forget warm-up entry point for `instrumentation.ts`. Errors are
// surfaced via console.warn so a missing/unfetchable model never crashes boot.
export const warmEmbedder = async (): Promise<void> => {
  try {
    await getEmbedder();
  } catch (error) {
    console.warn("warmEmbedder failed:", error);
  }
};
