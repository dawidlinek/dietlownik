import { setTimeout as sleep } from "node:timers/promises";

import { beforeAll, describe, expect, it, vi } from "vitest";

// Match the shim used in `embeddings.test.ts`. `lib/embeddings.ts` no longer
// imports `server-only` literally, but we keep the mock so the test surface is
// resilient if the literal import is ever restored.
vi.mock("server-only", () => ({}));

const HEAVY_SKIP = process.env.SKIP_HEAVY_TESTS === "1";
const DB_SKIP =
  process.env.DATABASE_URL === undefined || process.env.DATABASE_URL === "";

// ── Pure (no DB) — vector shape, determinism, batch equivalence ──────────────
//
// These tests exercise the embedder mechanically: right shape, L2-normalised,
// deterministic, batch-equals-single. Model-agnostic — `embedder.dim` is the
// runtime authority (currently 384 for e5-small; was 1024 for bge-m3).
describe.skipIf(HEAVY_SKIP)("embedder vector mechanics", () => {
  vi.setConfig({ testTimeout: 300_000 });

  it("returns Float32Array with the expected dimension", async () => {
    const { getEmbedder } = await import("../embeddings.js");
    const embedder = await getEmbedder();
    const v = await embedder.embed("kurczak z ryżem");
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(embedder.dim);
    // The current production model is e5-small (384-d). If you change the
    // model, update lib/embeddings.ts DIM and run the v8 migration.
    expect(embedder.dim).toBe(384);
  });

  it("L2-normalises output to unit length", async () => {
    const { getEmbedder } = await import("../embeddings.js");
    const embedder = await getEmbedder();
    const v = await embedder.embed("łosoś pieczony z koprem");
    let sumSq = 0;
    for (const x of v) {
      sumSq += x * x;
    }
    // Pipeline runs with normalize: true → norm ≈ 1.0 within float32 noise.
    expect(Math.sqrt(sumSq)).toBeCloseTo(1, 3);
  });

  it("is deterministic for the same input", async () => {
    const { getEmbedder, cosine } = await import("../embeddings.js");
    const embedder = await getEmbedder();
    const a = await embedder.embed("twaróg ze szczypiorkiem");
    const b = await embedder.embed("twaróg ze szczypiorkiem");
    expect(cosine(a, b)).toBeCloseTo(1, 5);
  });

  it("single embed and batch-of-one return the same vector", async () => {
    const { getEmbedder, cosine } = await import("../embeddings.js");
    const embedder = await getEmbedder();
    const single = await embedder.embed("placki ziemniaczane");
    const [batched] = await embedder.embedBatch(["placki ziemniaczane"]);
    expect(cosine(single, batched)).toBeCloseTo(1, 4);
  });

  it("preserves per-item identity across multi-element batches", async () => {
    const { getEmbedder, cosine } = await import("../embeddings.js");
    const embedder = await getEmbedder();
    const inputs = ["pierogi ruskie", "zupa pomidorowa", "naleśniki z serem"];
    const [a, b, c] = await embedder.embedBatch(inputs);
    const aSolo = await embedder.embed(inputs[0]);
    const bSolo = await embedder.embed(inputs[1]);
    const cSolo = await embedder.embed(inputs[2]);
    // Batch and per-item runs diverge by attention-mask padding + softmax
    // quantisation noise; empirically cosine lands at ~0.989. The point of
    // this test is to catch a true regression (batches yielding the wrong
    // item slot, ~0 cosine) rather than to assert bitwise equality.
    expect(cosine(a, aSolo)).toBeGreaterThan(0.98);
    expect(cosine(b, bSolo)).toBeGreaterThan(0.98);
    expect(cosine(c, cSolo)).toBeGreaterThan(0.98);
  });

  it("handles empty strings without crashing", async () => {
    const { getEmbedder } = await import("../embeddings.js");
    const embedder = await getEmbedder();
    // Empty input may produce a degenerate-but-valid vector. We don't assert
    // semantic meaning — only that it doesn't crash and stays correctly shaped.
    const v = await embedder.embed("");
    expect(v.length).toBe(embedder.dim);
  });
});

// ── Semantic ordering — DROPPED for e5-small ─────────────────────────────────
//
// We used to assert relative orderings on contrived Polish food pairs
// (gluten↔pszenica > gluten↔jabłko; białko↔proteina > białko↔cukier; etc.).
// These were tuned to bge-m3's geometry. e5-small compresses cosine into a
// tighter 0.7–0.95 band, and not every contrived pair preserves the ordering
// — yet e5-small wins MAP/NDCG/AUROC across 4 LLM oracles on actual ranking
// of 15k Polish meals (see EMBEDDINGS.md). The contrived pairs were a
// misleading smoke; the real semantic test surface is now the property-based
// queries-ranked-multiclause.test.ts integration suite + the bench data.

// ── Live DB — keyword embedding cache ────────────────────────────────────────
describe.skipIf(HEAVY_SKIP || DB_SKIP)("embedKeyword cache", () => {
  vi.setConfig({ testTimeout: 300_000 });

  // Use a probe keyword unlikely to collide with the live taxonomy or any
  // ingredient name actually scraped — preserves cache hygiene across runs.
  const PROBE = `__cache-probe-${Math.random().toString(36).slice(2, 10)}`;

  beforeAll(async () => {
    const { query } = await import("../db.js");
    await query(`DELETE FROM keyword_embeddings WHERE keyword = $1`, [PROBE]);
  });

  it("persists the embedding on first call and reuses it on second", async () => {
    const { embedKeyword, cosine, getEmbedder } =
      await import("../embeddings.js");
    const { query } = await import("../db.js");
    const embedder = await getEmbedder();

    const first = await embedKeyword(PROBE);
    expect(first.length).toBe(embedder.dim);

    const after1 = await query<{
      readonly created_at: string;
      readonly last_used_at: string;
    }>(
      `SELECT created_at::text, last_used_at::text FROM keyword_embeddings WHERE keyword = $1`,
      [PROBE]
    );
    expect(after1).toHaveLength(1);
    const t1 = new Date(after1[0].last_used_at).getTime();

    // Tiny wait to advance NOW() between calls. 25 ms is plenty inside the
    // same transaction-free request flow.
    await sleep(25);

    const second = await embedKeyword(PROBE);
    // Cached vector must equal the freshly-embedded one to working precision.
    expect(cosine(first, second)).toBeCloseTo(1, 5);

    const after2 = await query<{ readonly last_used_at: string }>(
      `SELECT last_used_at::text FROM keyword_embeddings WHERE keyword = $1`,
      [PROBE]
    );
    const t2 = new Date(after2[0].last_used_at).getTime();
    expect(t2).toBeGreaterThanOrEqual(t1);
  });

  it("normalises lookup case-insensitively (PROBE === probe)", async () => {
    const { embedKeyword, cosine } = await import("../embeddings.js");
    const upper = await embedKeyword(PROBE.toUpperCase());
    const lower = await embedKeyword(PROBE.toLowerCase());
    // Even if normalisation is case-preserving in the cache key, the cached
    // vector for PROBE (lowercased) should still come back equal.
    expect(cosine(upper, lower)).toBeCloseTo(1, 5);
  });
});
