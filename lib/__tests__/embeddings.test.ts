import { describe, expect, it, vi } from "vitest";

// `lib/embeddings.ts` was originally specified to open with
// `import 'server-only'`. We replaced that literal import with a runtime
// `window`/`document` guard (see the file for rationale) so the module loads
// cleanly under both Next and tsx; we keep the mock here as a belt-and-braces
// shim in case the literal import is restored later. The dynamic import below
// must stay so any future top-level `server-only` import is intercepted.
vi.mock("server-only", () => ({}));

const HEAVY_SKIP = process.env.SKIP_HEAVY_TESTS === "1";

// These are property-based smoke tests: relative orderings only, so they
// survive a model swap without re-tuning. The previous bge-m3-era thresholds
// (e.g. `<0.6` for unrelated pairs) don't survive the move to e5-small, which
// compresses cosine similarity into a tight 0.7–0.95 band by design — see
// EMBEDDINGS.md for the calibration rationale.
describe.skipIf(HEAVY_SKIP)("embedder cosine smoke (model-agnostic)", () => {
  // Cold-load + first inference can take ~10 s the first time after a fresh
  // checkout (longer — minutes — on the very first run when ONNX weights
  // download from HuggingFace).
  vi.setConfig({ testTimeout: 300_000 });

  it("matches semantically related Polish food terms (shake ↔ koktajl)", async () => {
    const { getEmbedder, cosine } = await import("../embeddings.js");
    const embedder = await getEmbedder();
    const [a, b] = await embedder.embedBatch([
      "shake",
      "koktajl mleczny truskawkowy",
    ]);
    const sim = cosine(a, b);
    expect(sim).toBeGreaterThan(0.5);
  });

  it("matches tomato variants (pomidor ↔ sos pomidorowy z bazylią)", async () => {
    const { getEmbedder, cosine } = await import("../embeddings.js");
    const embedder = await getEmbedder();
    const [a, b] = await embedder.embedBatch([
      "pomidor",
      "sos pomidorowy z bazylią",
    ]);
    const sim = cosine(a, b);
    expect(sim).toBeGreaterThan(0.5);
  });

  it("ranks related pair above unrelated pair (relative ordering)", async () => {
    const { getEmbedder, cosine } = await import("../embeddings.js");
    const embedder = await getEmbedder();
    const [tomato, tomatoSauce, oatmeal] = await embedder.embedBatch([
      "pomidor",
      "sos pomidorowy z bazylią",
      "owsianka z malinami",
    ]);
    // Relative comparison: tomato should be closer to tomato-sauce than to
    // a raspberry-oatmeal dish. Absolute thresholds vary by model; only the
    // ordering is invariant.
    const related = cosine(tomato, tomatoSauce);
    const unrelated = cosine(tomato, oatmeal);
    expect(related).toBeGreaterThan(unrelated);
  });
});
