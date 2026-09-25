import { beforeAll, describe, expect, it, vi } from "vitest";

// `lib/embeddings.ts` was originally specified to open with
// `import 'server-only'`. Agent B (Wave 1) replaced that literal import with a
// runtime guard, but we still mock it here in case the literal import is
// restored later — mirrors `lib/__tests__/embeddings.test.ts`.
vi.mock("server-only", () => ({}));

const HEAVY_SKIP = process.env.SKIP_HEAVY_TESTS === "1";
// Category routing hits the live taxonomy table; the rest of routePreferences
// is in-memory. Skip the DB-touching cases when DATABASE_URL is absent so the
// suite still exercises allergen + macro + empty-input paths in CI.
const NO_DB =
  process.env.DATABASE_URL === undefined || process.env.DATABASE_URL === "";

describe.skipIf(HEAVY_SKIP)("routePreferences", () => {
  // Test 4 cold-loads bge-m3 (~570 MB int8 weights) and may also download
  // them on a fresh checkout — give it the same generous budget the
  // embeddings smoke uses.
  vi.setConfig({ testTimeout: 300_000 });

  beforeAll(async () => {
    if (NO_DB) {
      return;
    }
    // Drop any cached taxonomy so the live DB is exercised once per file.
    const mod = await import("../preference-router.js");
    mod.resetTaxonomyCache();
  });

  it("routes a known allergen ('gluten') to the allergen bucket", async () => {
    const { routePreferences } = await import("../preference-router.js");
    const result = await routePreferences({
      avoid: [],
      prefer: ["gluten"],
    });
    expect(result.allergen).toHaveLength(1);
    expect(result.allergen[0]).toEqual({
      allergen: "gluten",
      channel: "prefer",
      keyword: "gluten",
      source: "allergen",
      spellings: ["gluten", "pszenica", "żyto", "jęczmień", "owies"],
    });
    expect(result.category).toHaveLength(0);
    expect(result.macro).toHaveLength(0);
    expect(result.embedding).toHaveLength(0);
  });

  it("matches eggs under the spelling the data uses ('jajka')", async () => {
    const { routePreferences } = await import("../preference-router.js");
    const result = await routePreferences({ avoid: ["jaja"], prefer: [] });
    expect(result.allergen[0].spellings).toContain("jajka");
  });

  it("routes 'bez X' onto the opposite list", async () => {
    const { routePreferences } = await import("../preference-router.js");
    const result = await routePreferences({
      avoid: ["bez jaj"],
      prefer: ["bez glutenu", "bez cukru"],
    });
    expect(result.allergen).toEqual([
      expect.objectContaining({
        allergen: "gluten",
        channel: "avoid",
        keyword: "bez glutenu",
      }),
      expect.objectContaining({
        allergen: "jaja",
        channel: "prefer",
        keyword: "bez jaj",
      }),
    ]);
    // "bez cukru" is claimed by the macro grammar before negation runs.
    expect(result.macro).toEqual([
      expect.objectContaining({ channel: "prefer", field: "sugar_g" }),
    ]);
    expect(result.ingredient).toHaveLength(0);
  });

  it("routes a macro phrase ('dużo białka') to the macro bucket", async () => {
    const { routePreferences } = await import("../preference-router.js");
    const result = await routePreferences({
      avoid: [],
      prefer: ["dużo białka"],
    });
    expect(result.macro).toHaveLength(1);
    expect(result.macro[0]).toEqual({
      channel: "prefer",
      field: "protein_g",
      keyword: "dużo białka",
      op: { kind: "high" },
      source: "macro",
    });
    expect(result.allergen).toHaveLength(0);
    expect(result.category).toHaveLength(0);
    expect(result.embedding).toHaveLength(0);
  });

  it.skipIf(NO_DB)(
    "routes a taxonomy category ('psiankowate') with members and channel 'avoid'",
    async () => {
      const { routePreferences } = await import("../preference-router.js");
      const result = await routePreferences({
        avoid: ["psiankowate"],
        prefer: [],
      });
      expect(result.category).toHaveLength(1);
      const [cat] = result.category;
      expect(cat.source).toBe("category");
      expect(cat.channel).toBe("avoid");
      expect(cat.category).toBe("psiankowate");
      expect(cat.keyword).toBe("psiankowate");
      expect(cat.patterns.length).toBeGreaterThan(0);
      expect(cat.patterns).toContain("pomidor");
      expect(result.allergen).toHaveLength(0);
      expect(result.macro).toHaveLength(0);
      expect(result.embedding).toHaveLength(0);
    }
  );

  it.skipIf(NO_DB)(
    "matches a multi-word taxonomy category on its spaced spelling",
    async () => {
      const { routePreferences } = await import("../preference-router.js");
      // The PK is 'owoce_morza'; nobody types the underscore. Before the
      // alias this fell through to lexical + semantic, where the stem
      // 'owoce morz' reached 19 ingredient rows against the 726 meals the
      // category's patterns cover, and the vector search returned avocado.
      const result = await routePreferences({
        avoid: ["owoce morza"],
        prefer: [],
      });
      expect(result.category).toHaveLength(1);
      const [cat] = result.category;
      expect(cat.category).toBe("owoce_morza");
      expect(cat.keyword).toBe("owoce morza");
      expect(cat.patterns).toContain("krewetk");
      expect(result.ingredient).toHaveLength(0);
      expect(result.embedding).toHaveLength(0);
    }
  );

  it.skipIf(NO_DB)(
    "routes unmatched keywords to embedding with per-channel tagging",
    async () => {
      const { routePreferences } = await import("../preference-router.js");
      const result = await routePreferences({
        avoid: ["pomidor"],
        prefer: ["kurczak"],
      });
      expect(result.embedding).toHaveLength(2);
      expect(result.allergen).toHaveLength(0);
      expect(result.category).toHaveLength(0);
      expect(result.macro).toHaveLength(0);

      const preferHit = result.embedding.find(
        (e: { readonly channel: string }) => e.channel === "prefer"
      );
      const avoidHit = result.embedding.find(
        (e: { readonly channel: string }) => e.channel === "avoid"
      );
      expect(preferHit).toBeDefined();
      expect(avoidHit).toBeDefined();
      if (preferHit === undefined || avoidHit === undefined) {
        return;
      }
      // Dimension comes from the live embedder, not a literal. This assertion
      // was pinned to 1024 (bge-m3) and silently wrong from the moment
      // production moved to e5-small/384 in `12ff3af` — invisible because the
      // whole suite skips without DATABASE_URL.
      const { getEmbedder } = await import("../embeddings.js");
      const { dim } = await getEmbedder();

      expect(preferHit.keyword).toBe("kurczak");
      expect(preferHit.vector).toBeInstanceOf(Float32Array);
      expect(preferHit.vector.length).toBe(dim);
      expect(avoidHit.keyword).toBe("pomidor");
      expect(avoidHit.vector).toBeInstanceOf(Float32Array);
      expect(avoidHit.vector.length).toBe(dim);
    }
  );

  it.skipIf(NO_DB)(
    "emits two embedding intents when the same keyword appears in both arrays",
    async () => {
      const { routePreferences } = await import("../preference-router.js");
      const result = await routePreferences({
        avoid: ["kurczak"],
        prefer: ["kurczak"],
      });
      expect(result.embedding).toHaveLength(2);
      const channels = result.embedding
        .map((e: { readonly channel: string }) => e.channel)
        .toSorted();
      expect(channels).toEqual(["avoid", "prefer"]);
    }
  );

  it("maps 'wysokokaloryczne' to high kcal", async () => {
    const { routePreferences } = await import("../preference-router.js");
    const result = await routePreferences({
      avoid: [],
      prefer: ["wysokokaloryczne"],
    });
    expect(result.macro).toHaveLength(1);
    expect(result.macro[0]).toEqual({
      channel: "prefer",
      field: "kcal",
      keyword: "wysokokaloryczne",
      op: { kind: "high" },
      source: "macro",
    });
  });

  it("parses 'pod 500 kcal' as a kcal max bound", async () => {
    const { routePreferences } = await import("../preference-router.js");
    const result = await routePreferences({
      avoid: [],
      prefer: ["pod 500 kcal"],
    });
    expect(result.macro).toHaveLength(1);
    expect(result.macro[0]).toEqual({
      channel: "prefer",
      field: "kcal",
      keyword: "pod 500 kcal",
      op: { kind: "max", value: 500 },
      source: "macro",
    });
  });

  it("drops empty and whitespace-only inputs", async () => {
    const { routePreferences } = await import("../preference-router.js");
    const result = await routePreferences({
      avoid: [" "],
      prefer: ["", "   ", "gluten"],
    });
    expect(result.allergen).toHaveLength(1);
    expect(result.allergen[0].allergen).toBe("gluten");
    expect(result.category).toHaveLength(0);
    expect(result.macro).toHaveLength(0);
    expect(result.embedding).toHaveLength(0);
  });
});
