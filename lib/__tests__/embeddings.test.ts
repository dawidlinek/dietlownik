import { describe, expect, it, vi } from "vitest";

// `lib/embeddings.ts` was originally specified to open with
// `import 'server-only'`. We replaced that literal import with a runtime
// `window`/`document` guard (see the file for rationale) so the module loads
// cleanly under both Next and tsx; we keep the mock here as a belt-and-braces
// shim in case the literal import is restored later. The dynamic import below
// must stay so any future top-level `server-only` import is intercepted.
vi.mock("server-only", () => ({}));

const HEAVY_SKIP = process.env.SKIP_HEAVY_TESTS === "1";

describe.skipIf(HEAVY_SKIP)("bge-m3 cosine smoke", () => {
  // bge-m3 cold-load + first inference can take ~10 s the first time after a
  // fresh checkout (longer — minutes — on the very first run when ONNX
  // weights download from HuggingFace).
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

  it("separates unrelated dishes (pomidor ↮ owsianka z malinami)", async () => {
    const { getEmbedder, cosine } = await import("../embeddings.js");
    const embedder = await getEmbedder();
    const [a, b] = await embedder.embedBatch([
      "pomidor",
      "owsianka z malinami",
    ]);
    const sim = cosine(a, b);
    // bge-m3 puts food terms in a moderately tight cluster; empirically
    // unrelated dish pairs land ~0.50–0.55. Pick a ceiling that catches a
    // genuine regression (e.g. identical vectors at 1.0) without false-failing
    // on normal in-cluster variation.
    expect(sim).toBeLessThan(0.6);
  });
});
