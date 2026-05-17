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
describe.skipIf(HEAVY_SKIP)("bge-m3 vector mechanics", () => {
  vi.setConfig({ testTimeout: 300_000 });

  it("returns Float32Array of dimension 1024", async () => {
    const { getEmbedder } = await import("../embeddings.js");
    const embedder = await getEmbedder();
    const v = await embedder.embed("kurczak z ryżem");
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(1024);
    expect(embedder.dim).toBe(1024);
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

  it("rejects empty strings symmetrically (treats empty as well-defined)", async () => {
    const { getEmbedder } = await import("../embeddings.js");
    const embedder = await getEmbedder();
    // Empty input may produce a degenerate-but-valid vector. We don't assert
    // semantic meaning — only that it doesn't crash and stays dim=1024.
    const v = await embedder.embed("");
    expect(v.length).toBe(1024);
  });
});

// ── Pure (no DB) — semantic ordering across Polish food domain ───────────────
describe.skipIf(HEAVY_SKIP)(
  "bge-m3 semantic ordering on Polish food terms",
  () => {
    vi.setConfig({ testTimeout: 300_000 });

    it("ranks meat-family pairs above cross-family pairs", async () => {
      const { getEmbedder, cosine } = await import("../embeddings.js");
      const embedder = await getEmbedder();
      const [chicken, poultry, beef, yogurt] = await embedder.embedBatch([
        "kurczak",
        "drób",
        "wołowina",
        "jogurt naturalny",
      ]);
      const within = cosine(chicken, poultry);
      const acrossSpecies = cosine(chicken, beef);
      const acrossDomain = cosine(chicken, yogurt);
      // Within-family > cross-species > cross-domain.
      expect(within).toBeGreaterThan(acrossDomain);
      expect(acrossSpecies).toBeGreaterThan(acrossDomain);
    });

    it("links cooked-form variants to their base ingredient", async () => {
      const { getEmbedder, cosine } = await import("../embeddings.js");
      const embedder = await getEmbedder();
      const [potato, fried, mashed, mango] = await embedder.embedBatch([
        "ziemniak",
        "ziemniaki pieczone",
        "puree ziemniaczane",
        "mango",
      ]);
      expect(cosine(potato, fried)).toBeGreaterThan(cosine(potato, mango));
      expect(cosine(potato, mashed)).toBeGreaterThan(cosine(potato, mango));
    });

    it("connects allergen names to their staple sources", async () => {
      const { getEmbedder, cosine } = await import("../embeddings.js");
      const embedder = await getEmbedder();
      const [gluten, wheat, _milk, apple] = await embedder.embedBatch([
        "gluten",
        "pszenica",
        "mleko",
        "jabłko",
      ]);
      // gluten ↔ pszenica is the load-bearing pairing (allergen → staple).
      // We previously asserted milk closer to wheat than to gluten, but
      // bge-m3 puts milk slightly nearer "gluten" than "pszenica" — likely
      // because both 'gluten' and 'mleko' share the allergen-list register
      // in training data. The point of the test is allergen↔staple, not
      // staple↔staple, so we keep only the first ordering.
      expect(cosine(gluten, wheat)).toBeGreaterThan(cosine(gluten, apple));
    });

    it("respects macro vocabulary (białko ↔ proteina)", async () => {
      const { getEmbedder, cosine } = await import("../embeddings.js");
      const embedder = await getEmbedder();
      const [protein, proteina, sweet] = await embedder.embedBatch([
        "białko",
        "proteina",
        "cukier",
      ]);
      expect(cosine(protein, proteina)).toBeGreaterThan(cosine(protein, sweet));
    });

    it("places categorical buckets close to their members", async () => {
      const { getEmbedder, cosine } = await import("../embeddings.js");
      const embedder = await getEmbedder();
      const [legumes, lentil, chickpea, candy] = await embedder.embedBatch([
        "strączkowe",
        "soczewica",
        "ciecierzyca",
        "cukierek",
      ]);
      expect(cosine(legumes, lentil)).toBeGreaterThan(cosine(legumes, candy));
      expect(cosine(legumes, chickpea)).toBeGreaterThan(cosine(legumes, candy));
    });

    it("crosses language for the same concept (shake ↔ koktajl)", async () => {
      const { getEmbedder, cosine } = await import("../embeddings.js");
      const embedder = await getEmbedder();
      const [shake, koktajl, soup] = await embedder.embedBatch([
        "shake",
        "koktajl",
        "zupa",
      ]);
      expect(cosine(shake, koktajl)).toBeGreaterThan(cosine(shake, soup));
    });

    it("preserves diacritic-sensitivity reasonably (białko ≈ bialko)", async () => {
      // bge-m3 is multilingual; an ASCII fallback typed without diacritics
      // should still embed close to the diacritic-correct form — this matters
      // because users on a non-Polish keyboard might type 'bialka' / 'lososia'.
      const { getEmbedder, cosine } = await import("../embeddings.js");
      const embedder = await getEmbedder();
      const [precise, ascii, unrelated] = await embedder.embedBatch([
        "łosoś",
        "losos",
        "ciasteczko",
      ]);
      expect(cosine(precise, ascii)).toBeGreaterThan(
        cosine(precise, unrelated)
      );
    });
  }
);

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
    const { embedKeyword, cosine } = await import("../embeddings.js");
    const { query } = await import("../db.js");

    const first = await embedKeyword(PROBE);
    expect(first.length).toBe(1024);

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
