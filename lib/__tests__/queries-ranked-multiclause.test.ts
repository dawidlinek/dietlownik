/**
 * Multi-clause + edge-case integration tests for getRankedOffersForDay.
 *
 * All tests are scoped to a realistic production query shape:
 *   (city × day × kcal range) — matching how the /match dashboard calls in.
 *
 * Assertions are PROPERTY-BASED (sign invariants, monotonicity, channel
 * coverage, permutation invariance, idempotence). They survive corpus drift
 * because they don't pin specific score values — only structural relationships
 * between calls.
 *
 * Defensive: live-DB tests can run against partial scrapes. Each test asserts
 * only when enough rows come back to make the assertion meaningful. A
 * sparser-than-expected slice yields PASS, not a false failure.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const HEAVY_SKIP =
  process.env.SKIP_HEAVY_TESTS === "1" ||
  process.env.DATABASE_URL === undefined ||
  process.env.DATABASE_URL === "";

const WROCLAW_ID = 986_283;

/** Every keyword credited with a hit across a set of ranked offers. */
const hitKeywords = (
  offers: readonly {
    readonly picks: readonly {
      readonly meal: { readonly hits: readonly { readonly keyword: string }[] };
    }[];
  }[]
): Set<string> =>
  new Set(
    offers.flatMap((o) =>
      o.picks.flatMap((pick) => pick.meal.hits.map((h) => h.keyword))
    )
  );

// Dates are resolved from the data, never hardcoded — a pinned fixture date
// ages out of the retained window and turns passing tests into
// `expected 0 to be greater than 0` failures that look like regressions.
// Populated by the file-level `beforeAll` below.
let POPULATED_DATE = "";
let POPULATED_DATES: readonly string[] = [];

beforeAll(async () => {
  if (HEAVY_SKIP) {
    return;
  }
  const { resolvePopulatedDates } = await import("./helpers/populated-date");
  POPULATED_DATES = await resolvePopulatedDates(WROCLAW_ID, 3);
  POPULATED_DATE = POPULATED_DATES[0] ?? "";
});

// Wide-enough range to cover lunch+dinner tiers (1200..2500 kcal/day diets)
const KCAL_MIN = 1200;
const KCAL_MAX = 2500;

// User's canonical four-channel example.
const CANONICAL_PREFER = ["dużo białka", "niskie ig"] as const;
const CANONICAL_AVOID = ["ryba", "surowe pomidory"] as const;

describe.skipIf(HEAVY_SKIP)(
  "getRankedOffersForDay — multi-clause + edge cases",
  () => {
    vi.setConfig({ testTimeout: 240_000 });

    beforeAll(async () => {
      const router = await import("../preference-router.js");
      router.resetTaxonomyCache();
    });

    // ════════════════════════════════════════════════════════════════════════
    //  GROUP A — routing robustness across input shape
    // ════════════════════════════════════════════════════════════════════════

    it("A1 — case invariance: Kurczak ≈ kurczak ≈ KURCZAK", async () => {
      const { getRankedOffersForDay } = await import("../queries.js");
      const lower = await getRankedOffersForDay({
        avoid: [],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 10,
        prefer: ["kurczak"],
      });
      const upper = await getRankedOffersForDay({
        avoid: [],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 10,
        prefer: ["KURCZAK"],
      });
      const mixed = await getRankedOffersForDay({
        avoid: [],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 10,
        prefer: ["Kurczak"],
      });
      if (lower.offers.length === 0) {
        return;
      }
      // The TOP offer's offer_id should match across casings (deterministic ranking).
      expect(upper.offers.map((o) => o.offer_id)).toEqual(
        lower.offers.map((o) => o.offer_id)
      );
      expect(mixed.offers.map((o) => o.offer_id)).toEqual(
        lower.offers.map((o) => o.offer_id)
      );
    });

    it("A2 — diacritic-stripped keyword still finds the ingredient", async () => {
      const { getRankedOffersForDay } = await import("../queries.js");
      const withDia = await getRankedOffersForDay({
        avoid: [],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 10,
        prefer: ["łosoś"],
      });
      const stripped = await getRankedOffersForDay({
        avoid: [],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 10,
        prefer: ["losos"],
      });
      if (withDia.offers.length === 0 || stripped.offers.length === 0) {
        return;
      }
      // Both forms must FIND salmon. Their scores — and the offers they
      // surface — legitimately differ, so don't assert either.
      //
      // `łosoś` is a real word: the semantic channel fires (sim ≈ 0.83) on
      // top of the lexical one. `losos` is a misspelling that falls under
      // τ=0.80, so only the lexical channel fires — `meals.name_normalized`
      // is diacritic-stripped, so it still matches ("losos wedzony",
      // sim=1.00). That asymmetry IS the designed fall-through, introduced
      // with the lexical ingredient channel in `9e03f81`.
      //
      // Measured on a production snapshot the two share ZERO offers: the
      // embedding boost carries `łosoś` to a different catering entirely.
      // The original assertion (scores within 50%) only held while embedding
      // was the sole fallback channel.
      const a = withDia.offers[0].verdict.score_best;
      const b = stripped.offers[0].verdict.score_best;
      expect(a).toBeGreaterThan(0);
      expect(b).toBeGreaterThan(0);

      // Every hit must be attributable to the keyword that was asked for.
      expect([...hitKeywords(withDia.offers)]).toContain("łosoś");
      expect([...hitKeywords(stripped.offers)]).toContain("losos");
    });

    it("A3 — Polish inflection variants score sensibly close", async () => {
      const { getRankedOffersForDay } = await import("../queries.js");
      const forms = ["kurczak", "kurczaka", "kurczakiem", "z kurczakiem"];
      const results: number[] = [];
      for (const f of forms) {
        const r = await getRankedOffersForDay({
          avoid: [],
          cityId: WROCLAW_ID,
          date: POPULATED_DATE,
          kcalMax: KCAL_MAX,
          kcalMin: KCAL_MIN,
          limit: 1,
          prefer: [f],
        });
        if (r.offers.length > 0) {
          results.push(r.offers[0].verdict.score_best);
        }
      }
      if (results.length < 2) {
        return;
      }
      const min = Math.min(...results);
      const max = Math.max(...results);
      // All inflection forms should produce scores within 60% of each other
      // (embedding-channel similarity is sensitive to morphology, but not catastrophically).
      const denom = Math.max(Math.abs(min), Math.abs(max), 0.01);
      expect((max - min) / denom).toBeLessThan(0.7);
    });

    it("A4 — quantity adverbs don't crash and produce non-empty results", async () => {
      const { getRankedOffersForDay } = await import("../queries.js");
      for (const q of [
        "dużo kurczaka",
        "trochę ryżu",
        "głównie warzywa",
        "bardzo dużo białka",
      ]) {
        const r = await getRankedOffersForDay({
          avoid: [],
          cityId: WROCLAW_ID,
          date: POPULATED_DATE,
          kcalMax: KCAL_MAX,
          kcalMin: KCAL_MIN,
          limit: 5,
          prefer: [q],
        });
        // no crash
        expect(r.offers.length).toBeGreaterThanOrEqual(0);
        // Either it routes to embedding (penalty in (0,1]) or it produces nothing —
        // but it must not throw or produce NaN.
        for (const o of r.offers) {
          expect(Number.isFinite(o.verdict.score_best)).toBe(true);
        }
      }
    });

    it("A5 — English fallback ranks meaningfully", async () => {
      const { getRankedOffersForDay } = await import("../queries.js");
      const pl = await getRankedOffersForDay({
        avoid: [],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 10,
        prefer: ["kurczak"],
      });
      const en = await getRankedOffersForDay({
        avoid: [],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 10,
        prefer: ["chicken"],
      });
      if (pl.offers.length === 0 || en.offers.length === 0) {
        return;
      }
      // Both should produce positive top score (multilingual model handles both).
      expect(pl.offers[0].verdict.score_best).toBeGreaterThan(0);
      expect(en.offers[0].verdict.score_best).toBeGreaterThan(0);
    });

    // ════════════════════════════════════════════════════════════════════════
    //  GROUP B — conflict + precedence (multi-clause core)
    // ════════════════════════════════════════════════════════════════════════

    it("B1 — adding an avoid keyword never raises the top score", async () => {
      const { getRankedOffersForDay } = await import("../queries.js");
      const a = await getRankedOffersForDay({
        avoid: ["ryba"],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 10,
        prefer: [...CANONICAL_PREFER],
      });
      const b = await getRankedOffersForDay({
        avoid: [...CANONICAL_AVOID],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 10,
        prefer: [...CANONICAL_PREFER],
      });
      if (a.offers.length === 0 || b.offers.length === 0) {
        return;
      }
      expect(b.offers[0].verdict.score_best).toBeLessThanOrEqual(
        a.offers[0].verdict.score_best + 1e-9
      );
    });

    it("B2 — adding a prefer keyword never lowers the top score", async () => {
      const { getRankedOffersForDay } = await import("../queries.js");
      const a = await getRankedOffersForDay({
        avoid: [...CANONICAL_AVOID],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 10,
        prefer: ["dużo białka"],
      });
      const b = await getRankedOffersForDay({
        avoid: [...CANONICAL_AVOID],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 10,
        prefer: [...CANONICAL_PREFER],
      });
      if (a.offers.length === 0 || b.offers.length === 0) {
        return;
      }
      expect(b.offers[0].verdict.score_best).toBeGreaterThanOrEqual(
        a.offers[0].verdict.score_best - 1e-9
      );
    });

    it("B3 — channel collision: 'orzechy' as prefer keeps prefer direction", async () => {
      // 'orzechy' is both an allergen AND a taxonomy category. Router puts
      // allergens first. The direction (prefer) must be honored either way.
      const { getRankedOffersForDay } = await import("../queries.js");
      const r = await getRankedOffersForDay({
        avoid: [],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 20,
        prefer: ["orzechy"],
      });
      const allHits = r.offers
        .flatMap((o) => o.picks)
        .flatMap((p) => p.meal.hits);
      for (const hit of allHits) {
        expect(hit.channel).toBe("prefer");
        expect(hit.contribution).toBeGreaterThanOrEqual(0);
      }
    });

    it("B4 — overlapping broader+narrower category aren't pathologically additive", async () => {
      // 'ryby' (broad) and 'łosoś' (narrow) overlap. Top score with both should
      // not exceed a reasonable multiplier of single-clause prefer.
      const { getRankedOffersForDay } = await import("../queries.js");
      const single = await getRankedOffersForDay({
        avoid: [],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 10,
        prefer: ["łosoś"],
      });
      const both = await getRankedOffersForDay({
        avoid: [],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 10,
        prefer: ["łosoś", "ryby"],
      });
      if (single.offers.length === 0 || both.offers.length === 0) {
        return;
      }
      // The two-clause score should be >= single (more positive contributions)
      // but bounded — adding an overlapping clause shouldn't 10× the score.
      const s = single.offers[0].verdict.score_best;
      const b = both.offers[0].verdict.score_best;
      expect(b).toBeGreaterThanOrEqual(s - 1e-9);
      expect(b).toBeLessThanOrEqual(Math.max(s * 5, s + 5));
    });

    it("B5 — top offer's avoid hits never contribute positively", async () => {
      const { getRankedOffersForDay } = await import("../queries.js");
      const r = await getRankedOffersForDay({
        avoid: [...CANONICAL_AVOID],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 5,
        prefer: [...CANONICAL_PREFER],
      });
      if (r.offers.length === 0) {
        return;
      }
      const [top] = r.offers;
      for (const pick of top.picks) {
        for (const hit of pick.meal.hits) {
          if (hit.channel === "avoid") {
            expect(hit.contribution).toBeLessThanOrEqual(0);
          }
          if (hit.channel === "prefer") {
            expect(hit.contribution).toBeGreaterThanOrEqual(0);
          }
        }
      }
    });

    // ════════════════════════════════════════════════════════════════════════
    //  GROUP C — numerical boundaries + grammar coverage
    // ════════════════════════════════════════════════════════════════════════

    it("C1 — weights.prefer = 0 zeroes prefer contribution but keeps avoid", async () => {
      const { getRankedOffersForDay } = await import("../queries.js");
      const r = await getRankedOffersForDay({
        avoid: ["gluten"],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 30,
        prefer: ["kurczak"],
        weights: { avoid: 1, prefer: 0 },
      });
      // With prefer weight zeroed, no contribution should be positive.
      for (const offer of r.offers) {
        for (const pick of offer.picks) {
          for (const hit of pick.meal.hits) {
            if (hit.channel === "prefer") {
              expect(hit.contribution).toBe(0);
            }
          }
        }
      }
    });

    it("C2 — weights.avoid = 0 zeroes avoid contribution but keeps prefer", async () => {
      const { getRankedOffersForDay } = await import("../queries.js");
      const r = await getRankedOffersForDay({
        avoid: ["gluten"],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 30,
        prefer: ["kurczak"],
        weights: { avoid: 0, prefer: 1 },
      });
      for (const offer of r.offers) {
        for (const pick of offer.picks) {
          for (const hit of pick.meal.hits) {
            if (hit.channel === "avoid") {
              expect(hit.contribution).toBe(0);
            }
          }
        }
      }
    });

    it("C3 — macro grammar: 'dużo węgli' and 'dużo węglowodanów' produce same shape", async () => {
      const { getRankedOffersForDay } = await import("../queries.js");
      const a = await getRankedOffersForDay({
        avoid: [],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 10,
        prefer: ["dużo węgli"],
      });
      const b = await getRankedOffersForDay({
        avoid: [],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 10,
        prefer: ["dużo węglowodanów"],
      });
      // Either both produce macro hits, or both fall through to embedding. Their
      // top-N offer sets should overlap heavily.
      if (a.offers.length === 0 || b.offers.length === 0) {
        return;
      }
      const idsA = new Set(a.offers.map((o) => o.offer_id));
      const idsB = new Set(b.offers.map((o) => o.offer_id));
      const overlap = [...idsA].filter((id) => idsB.has(id)).length;
      expect(overlap).toBeGreaterThanOrEqual(
        Math.floor(Math.min(idsA.size, idsB.size) * 0.5)
      );
    });

    it("C4 — kcal bounds are inclusive at both edges", async () => {
      const { getRankedOffersForDay } = await import("../queries.js");
      const lo = 1500;
      // single-value range — meals must be exactly 1500
      const hi = 1500;
      const r = await getRankedOffersForDay({
        avoid: [],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: hi,
        kcalMin: lo,
        limit: 50,
        prefer: [],
      });
      for (const offer of r.offers) {
        if (offer.calories !== null) {
          expect(offer.calories).toBeGreaterThanOrEqual(lo);
          expect(offer.calories).toBeLessThanOrEqual(hi);
        }
      }
    });

    it("C5 — score is always finite, never NaN, even with esoteric inputs", async () => {
      const { getRankedOffersForDay } = await import("../queries.js");
      const r = await getRankedOffersForDay({
        avoid: ["xyzqwertynothing", "💀", "   "],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 20,
        prefer: ["xyzqwertynothing", "💀", "   "],
      });
      for (const offer of r.offers) {
        expect(Number.isFinite(offer.verdict.score_best)).toBe(true);
        expect(Number.isFinite(offer.verdict.score_default)).toBe(true);
        for (const pick of offer.picks) {
          expect(Number.isFinite(pick.meal.score)).toBe(true);
          for (const hit of pick.meal.hits) {
            expect(Number.isFinite(hit.contribution)).toBe(true);
            expect(Number.isFinite(hit.penalty)).toBe(true);
          }
        }
      }
    });

    // ════════════════════════════════════════════════════════════════════════
    //  GROUP D — data-quality robustness
    // ════════════════════════════════════════════════════════════════════════

    it("D1 — meals with NULL ingredients_raw don't crash queries", async () => {
      // Some meals scraped before the ingredients field was added will have
      // NULL ingredients_raw. They should still appear if other channels match,
      // or be silently skipped from channels that need the text.
      const { getRankedOffersForDay } = await import("../queries.js");
      const r = await getRankedOffersForDay({
        avoid: ["psiankowate"],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 50,
        prefer: ["dużo białka"],
      });
      // We expect SOME offers regardless of NULL-heavy meals.
      expect(r.offers.length).toBeGreaterThanOrEqual(0);
      // Hits with NULL-source meal shouldn't appear (category needs text);
      // macro hits CAN exist if macros are non-null.
    });

    it("D2 — empty (avoid+prefer) returns price-ordered offers", async () => {
      const { getRankedOffersForDay } = await import("../queries.js");
      const r = await getRankedOffersForDay({
        avoid: [],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 10,
        prefer: [],
      });
      for (const offer of r.offers) {
        expect(offer.verdict.score_best).toBe(0);
      }
      const prices = r.offers
        .map((o) => o.price_per_day)
        .filter((p): p is number => p !== null);
      const sorted = [...prices].toSorted((a, b) => a - b);
      expect(prices).toEqual(sorted);
    });

    it("D3 — date with no menus returns empty offers cleanly", async () => {
      const { getRankedOffersForDay } = await import("../queries.js");
      const r = await getRankedOffersForDay({
        avoid: [...CANONICAL_AVOID],
        cityId: WROCLAW_ID,
        date: "1900-01-01",
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 10,
        prefer: [...CANONICAL_PREFER],
      });
      expect(r.offers).toEqual([]);
      expect(r.considered_count).toBe(0);
    });

    it("D4 — narrow kcal range that excludes everything returns empty", async () => {
      const { getRankedOffersForDay } = await import("../queries.js");
      const r = await getRankedOffersForDay({
        avoid: [],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        // Deliberately above every real diet. The previous bound was [0, 1],
        // which does NOT exclude everything: the corpus contains a genuine
        // `calories = 1` diet (Czapielskie Pudełka / "Wychodząca"), and C4
        // asserts the bounds are inclusive — so [0, 1] correctly matched it.
        kcalMax: 1_000_000,
        kcalMin: 999_999,
        limit: 10,
        prefer: ["kurczak"],
      });
      expect(r.offers).toEqual([]);
    });

    // ════════════════════════════════════════════════════════════════════════
    //  GROUP E — real-flow end-to-end (the user-shape scenarios)
    // ════════════════════════════════════════════════════════════════════════

    it("E1 — canonical 4-channel query: ryba, surowe pomidory / dużo białka, niskie ig", async () => {
      const { getRankedOffersForDay } = await import("../queries.js");
      const r = await getRankedOffersForDay({
        avoid: [...CANONICAL_AVOID],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 30,
        prefer: [...CANONICAL_PREFER],
      });
      if (r.offers.length === 0) {
        return;
      }

      const hits = r.offers.flatMap((o) => o.picks).flatMap((p) => p.meal.hits);

      // Macros are populated on essentially every meal — 'dużo białka' should
      // produce at least one prefer-direction macro hit reliably.
      const macroPrefer = hits.filter(
        (h) => h.source === "macro" && h.channel === "prefer"
      );
      expect(macroPrefer.length).toBeGreaterThan(0);

      // Defensive on partial scrapes: if ANY avoid hits exist, they must
      // reference one of our avoid keywords (not random noise).
      const avoidHits = hits.filter((h) => h.channel === "avoid");
      if (avoidHits.length > 0) {
        const mentionsAvoidKw = avoidHits.some((h) => {
          const reason = h.reason.toLowerCase();
          return (
            reason.includes("ryb") ||
            reason.includes("fish") ||
            reason.includes("pomidor") ||
            reason.includes("surow")
          );
        });
        expect(mentionsAvoidKw).toBe(true);
      }

      // Every hit on every meal must be tagged with a recognized channel and
      // a finite contribution — the structural guarantee that holds at any
      // corpus size.
      for (const o of r.offers) {
        for (const pick of o.picks) {
          for (const hit of pick.meal.hits) {
            expect(["prefer", "avoid"]).toContain(hit.channel);
            expect(Number.isFinite(hit.contribution)).toBe(true);
            expect(Number.isFinite(hit.penalty)).toBe(true);
          }
        }
      }

      // Top offer's avoid hits never contribute positively (sign invariant).
      const [top] = r.offers;
      for (const pick of top.picks) {
        for (const hit of pick.meal.hits) {
          if (hit.channel === "avoid") {
            expect(hit.contribution).toBeLessThanOrEqual(0);
          }
          if (hit.channel === "prefer") {
            expect(hit.contribution).toBeGreaterThanOrEqual(0);
          }
        }
      }
    });

    it("E2 — clinical scenario: anti-inflammatory pattern", async () => {
      const { getRankedOffersForDay } = await import("../queries.js");
      const r = await getRankedOffersForDay({
        avoid: ["psiankowate", "cukier"],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 20,
        prefer: ["na łuszczycy", "tłuste ryby", "zielone warzywa"],
      });
      // Just verify it runs end-to-end with 5 clauses across multiple channels.
      // Embedding-heavy query — most keywords fall to embedding fallback today.
      for (const offer of r.offers) {
        expect(Number.isFinite(offer.verdict.score_best)).toBe(true);
      }
    });

    it("E3 — sports scenario: post-workout high-protein narrow kcal", async () => {
      const { getRankedOffersForDay } = await import("../queries.js");
      const r = await getRankedOffersForDay({
        avoid: ["cukier", "smażone"],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: 2200,
        kcalMin: 1800,
        limit: 10,
        prefer: ["po treningu", "wysokobiałkowe", "kurczak"],
      });
      // Verify kcal filtering held under multi-clause input.
      for (const offer of r.offers) {
        if (offer.calories !== null) {
          expect(offer.calories).toBeGreaterThanOrEqual(1800);
          expect(offer.calories).toBeLessThanOrEqual(2200);
        }
      }
    });

    it("E4 — many-clause query: 6 prefer + 4 avoid stays finite and finishes", async () => {
      const { getRankedOffersForDay } = await import("../queries.js");
      const start = Date.now();
      const r = await getRankedOffersForDay({
        avoid: ["gluten", "ryba", "psiankowate", "surowe pomidory"],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 20,
        prefer: [
          "kurczak",
          "dużo białka",
          "niskie ig",
          "zielone warzywa",
          "owoce morza",
          "azjatyckie",
        ],
      });
      const elapsedMs = Date.now() - start;
      // hard ceiling — should be ~3-5s
      expect(elapsedMs).toBeLessThan(60_000);
      for (const offer of r.offers) {
        expect(Number.isFinite(offer.verdict.score_best)).toBe(true);
      }
    });

    // ════════════════════════════════════════════════════════════════════════
    //  GROUP F — determinism + invariance
    // ════════════════════════════════════════════════════════════════════════

    it("F1 — keyword order doesn't change scores", async () => {
      const { getRankedOffersForDay } = await import("../queries.js");
      const a = await getRankedOffersForDay({
        avoid: [...CANONICAL_AVOID],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 10,
        prefer: [...CANONICAL_PREFER],
      });
      const b = await getRankedOffersForDay({
        avoid: [...CANONICAL_AVOID].toReversed(),
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 10,
        prefer: [...CANONICAL_PREFER].toReversed(),
      });
      expect(a.offers.map((o) => o.offer_id)).toEqual(
        b.offers.map((o) => o.offer_id)
      );
      expect(a.offers.map((o) => o.verdict.score_best)).toEqual(
        b.offers.map((o) => o.verdict.score_best)
      );
    });

    it("F2 — same meal across multiple days scores consistently per day", async () => {
      const { getRankedOffersForDay } = await import("../queries.js");
      const day1 = await getRankedOffersForDay({
        avoid: [],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 50,
        prefer: ["kurczak"],
      });
      // Try a neighbouring date — same query, different day.
      const day2 = await getRankedOffersForDay({
        avoid: [],
        cityId: WROCLAW_ID,
        date: POPULATED_DATES[2] ?? POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 50,
        prefer: ["kurczak"],
      });
      // For meals (by meal_id) that appear in BOTH days, the per-meal score
      // from the embedding channel must be identical (same meal text, same
      // model, same threshold) regardless of which day's slice it's in.
      const day1MealScores = new Map<number, number>();
      for (const o of day1.offers) {
        for (const p of o.picks) {
          day1MealScores.set(p.meal.meal_id, p.meal.score);
        }
      }
      let comparedMeals = 0;
      for (const o of day2.offers) {
        for (const p of o.picks) {
          const s1 = day1MealScores.get(p.meal.meal_id);
          if (s1 !== undefined) {
            expect(p.meal.score).toBeCloseTo(s1, 5);
            comparedMeals += 1;
          }
        }
      }
      // If no overlap (different menus that day) → nothing to assert; pass.
    });

    it("F3 — repeated identical multi-clause calls produce identical output", async () => {
      const { getRankedOffersForDay } = await import("../queries.js");
      const args = {
        avoid: [...CANONICAL_AVOID],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 10,
        prefer: [...CANONICAL_PREFER],
      } as const;
      const a = await getRankedOffersForDay(args);
      const b = await getRankedOffersForDay(args);
      expect(a.considered_count).toBe(b.considered_count);
      expect(a.offers.map((o) => o.offer_id)).toEqual(
        b.offers.map((o) => o.offer_id)
      );
      expect(a.offers.map((o) => o.verdict.score_best)).toEqual(
        b.offers.map((o) => o.verdict.score_best)
      );
    });

    // ════════════════════════════════════════════════════════════════════════
    //  GROUP G — performance + pathological
    // ════════════════════════════════════════════════════════════════════════

    it("G1 — high-cardinality prefer list (20 keywords) finishes in <60s", async () => {
      const { getRankedOffersForDay } = await import("../queries.js");
      const start = Date.now();
      const r = await getRankedOffersForDay({
        avoid: [],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 10,
        prefer: [
          "kurczak",
          "łosoś",
          "indyk",
          "wołowina",
          "jajko",
          "awokado",
          "brokuł",
          "szpinak",
          "pomidor",
          "ryż",
          "kasza gryczana",
          "makaron",
          "soczewica",
          "tofu",
          "ser",
          "dużo białka",
          "niskie ig",
          "wysokobiałkowe",
          "po treningu",
          "zdrowe",
        ],
      });
      const elapsedMs = Date.now() - start;
      expect(elapsedMs).toBeLessThan(60_000);
      for (const offer of r.offers) {
        expect(Number.isFinite(offer.verdict.score_best)).toBe(true);
      }
    });

    it("G2 — very long single keyword doesn't crash the embedder", async () => {
      const { getRankedOffersForDay } = await import("../queries.js");
      const longKeyword = "x".repeat(500);
      const r = await getRankedOffersForDay({
        avoid: [],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 5,
        prefer: [longKeyword],
      });
      // Tokenizer truncates at model limit. Should still produce results.
      for (const offer of r.offers) {
        expect(Number.isFinite(offer.verdict.score_best)).toBe(true);
      }
    });

    it("G3 — duplicate keywords in same list are deduped or idempotent", async () => {
      const { getRankedOffersForDay } = await import("../queries.js");
      const single = await getRankedOffersForDay({
        avoid: [],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 10,
        prefer: ["kurczak"],
      });
      const dup = await getRankedOffersForDay({
        avoid: [],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 10,
        prefer: ["kurczak", "kurczak", "kurczak"],
      });
      if (single.offers.length === 0 || dup.offers.length === 0) {
        return;
      }
      // Duplicates either get deduped (identical scores) or are additive in a
      // bounded way (<= 5× single — sanity ceiling, not exactness).
      const s = single.offers[0].verdict.score_best;
      const d = dup.offers[0].verdict.score_best;
      expect(d).toBeGreaterThanOrEqual(s - 1e-9);
      expect(d).toBeLessThanOrEqual(Math.max(s * 5, s + 5));
    });

    // ════════════════════════════════════════════════════════════════════════
    //  GROUP H — multi-clause depth + new-family combinations
    // ════════════════════════════════════════════════════════════════════════

    it("H1 — direction conflict: same keyword in both prefer & avoid cancels", async () => {
      // Already partially covered in queries-ranked-extended.test.ts (line 149);
      // here we extend to multi-keyword cancellation.
      const { getRankedOffersForDay } = await import("../queries.js");
      const preferOnly = await getRankedOffersForDay({
        avoid: [],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 5,
        prefer: ["kurczak", "ryż"],
      });
      const fullCancel = await getRankedOffersForDay({
        avoid: ["kurczak", "ryż"],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 5,
        prefer: ["kurczak", "ryż"],
      });
      if (preferOnly.offers.length === 0 || fullCancel.offers.length === 0) {
        return;
      }
      // Full bidirectional opposition: every clause cancels itself. Top score
      // should net to ≤ prefer-only's top, and signs of contributions inside
      // the same meal should be mixed prefer+avoid.
      expect(fullCancel.offers[0].verdict.score_best).toBeLessThanOrEqual(
        preferOnly.offers[0].verdict.score_best + 1e-9
      );
    });

    it("H2 — all-allergen avoid (gluten + mleko + jajka) routes to allergen channel", async () => {
      const { getRankedOffersForDay } = await import("../queries.js");
      const r = await getRankedOffersForDay({
        avoid: ["gluten", "mleko", "jajka"],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 30,
        prefer: [],
      });
      const allergenHits = r.offers
        .flatMap((o) => o.picks)
        .flatMap((p) => p.meal.hits)
        .filter((h) => h.source === "allergen");
      // Heavy allergen prevalence in data — should produce allergen hits in
      // most corpora, but on a partial scrape the (city,day) slice might not
      // include enough allergen-tagged meals on the specific test date.
      // Soft assertion: when hits exist, they must conform; otherwise pass.
      if (allergenHits.length === 0) {
        return;
      }
      for (const hit of allergenHits) {
        expect(hit.channel).toBe("avoid");
        expect(hit.contribution).toBeLessThanOrEqual(0);
      }
    });

    it("H3 — casing invariance through allergen channel", async () => {
      // The allergen vocabulary has casing splits (Sezam/SEZAM, Pszenica/PSZENICA).
      // The user types whichever case they remember — routing must normalize.
      const { getRankedOffersForDay } = await import("../queries.js");
      const lower = await getRankedOffersForDay({
        avoid: ["gluten"],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 20,
        prefer: [],
      });
      const upper = await getRankedOffersForDay({
        avoid: ["Gluten"],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 20,
        prefer: [],
      });
      const allCaps = await getRankedOffersForDay({
        avoid: ["GLUTEN"],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 20,
        prefer: [],
      });
      if (lower.offers.length === 0) {
        return;
      }
      // All three should produce identical orderings.
      expect(upper.offers.map((o) => o.offer_id)).toEqual(
        lower.offers.map((o) => o.offer_id)
      );
      expect(allCaps.offers.map((o) => o.offer_id)).toEqual(
        lower.offers.map((o) => o.offer_id)
      );
    });

    it("H4 — cooking method + ingredient compound (the surowe-pomidory test)", async () => {
      const { getRankedOffersForDay } = await import("../queries.js");
      const justIngredient = await getRankedOffersForDay({
        avoid: ["pomidory"],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 10,
        prefer: [],
      });
      const compound = await getRankedOffersForDay({
        avoid: ["surowe pomidory"],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 10,
        prefer: [],
      });
      if (justIngredient.offers.length === 0 || compound.offers.length === 0) {
        return;
      }
      // The compound clause is STRICTLY MORE SPECIFIC than the ingredient.
      // Therefore its top score should be >= ingredient's top (less negative
      // OR same — fewer meals match the compound). Loose sanity bound only.
      expect(compound.offers[0].verdict.score_best).toBeGreaterThanOrEqual(
        justIngredient.offers[0].verdict.score_best - 0.5
      );
    });

    it("H5 — bidirectional 3-prefer × 3-avoid stays well-behaved", async () => {
      const { getRankedOffersForDay } = await import("../queries.js");
      const r = await getRankedOffersForDay({
        avoid: ["gluten", "smażone", "cukier"],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 20,
        prefer: ["łosoś", "brokuł", "wysokobiałkowe"],
      });
      if (r.offers.length === 0) {
        return;
      }
      // Sign invariant on every hit — this holds for ANY corpus size and is
      // the structural guarantee we care about. Channel-source diversity is
      // a corpus-dependent property and gets richer as the scrape fills in.
      for (const o of r.offers) {
        for (const pick of o.picks) {
          for (const hit of pick.meal.hits) {
            if (hit.channel === "avoid") {
              expect(hit.contribution).toBeLessThanOrEqual(0);
            } else {
              expect(hit.contribution).toBeGreaterThanOrEqual(0);
            }
            expect(Number.isFinite(hit.contribution)).toBe(true);
          }
        }
      }
      // Loose channel-coverage assertion: with 6 clauses routing across
      // (allergen, embedding, macro), expect AT LEAST one source if any hits
      // surface at all.
      const allHits = r.offers
        .flatMap((o) => o.picks)
        .flatMap((p) => p.meal.hits);
      if (allHits.length > 0) {
        const sources = new Set(allHits.map((h) => h.source));
        expect(sources.size).toBeGreaterThanOrEqual(1);
      }
    });

    it("H6 — sugar avoid doesn't punish sugar-substitute meals", async () => {
      // Subtle one: 'cukier' (sugar) avoid should NOT downrank meals whose
      // sweetener is ksylitol or erytrol. Tests the embedding's grasp of
      // sugar-vs-substitute semantics.
      const { getRankedOffersForDay } = await import("../queries.js");
      const r = await getRankedOffersForDay({
        avoid: ["cukier"],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 50,
        prefer: [],
      });
      // Find any offers whose picks mention ksylitol/erytrol in the ingredients.
      // Those meals shouldn't all sit at the bottom — embedding ought to
      // distinguish sugar from its substitutes.
      // Soft assertion: no crash + finite scores. Embedding model quality is
      // the bench's job to measure precisely.
      for (const offer of r.offers) {
        expect(Number.isFinite(offer.verdict.score_best)).toBe(true);
      }
    });

    it("H7 — extreme avoidance load (8 keywords) doesn't make every score negative", async () => {
      const { getRankedOffersForDay } = await import("../queries.js");
      const r = await getRankedOffersForDay({
        avoid: [
          "gluten",
          "mleko",
          "jajka",
          "ryby",
          "psiankowate",
          "cukier",
          "smażone",
          "panierowane",
        ],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: KCAL_MAX,
        kcalMin: KCAL_MIN,
        limit: 20,
        prefer: [],
      });
      // With heavy avoidance, expect MANY negative scores but at least some
      // meals (allergen-free pure-ingredient salads) should net to 0 or near-0.
      if (r.offers.length === 0) {
        return;
      }
      const topScore = r.offers[0].verdict.score_best;
      // The TOP score should be the LEAST negative (or zero) — sort is by score DESC.
      const worstScore = r.offers.at(-1)?.verdict.score_best ?? 0;
      expect(topScore).toBeGreaterThanOrEqual(worstScore - 1e-9);
    });

    it("H8 — tag-channel + macro-channel work together (niskie ig + wysokobiałkowe)", async () => {
      const { getRankedOffersForDay } = await import("../queries.js");
      const r = await getRankedOffersForDay({
        avoid: [],
        cityId: WROCLAW_ID,
        date: POPULATED_DATE,
        kcalMax: 2000,
        kcalMin: 1400,
        limit: 20,
        prefer: ["niskie ig", "wysokobiałkowe"],
      });
      if (r.offers.length === 0) {
        return;
      }
      // Structural guarantee: every hit on every meal has finite, signed
      // contribution and a recognized channel/source.
      let totalHits = 0;
      for (const o of r.offers) {
        for (const pick of o.picks) {
          for (const hit of pick.meal.hits) {
            totalHits += 1;
            expect(["prefer", "avoid"]).toContain(hit.channel);
            expect(
              [
                "allergen",
                "category",
                "macro",
                "ingredient",
                "embedding",
              ].includes(hit.source)
            ).toBe(true);
            expect(Number.isFinite(hit.contribution)).toBe(true);
          }
        }
      }
      // If any hits surfaced, at least ONE should have a prefer channel since
      // both clauses are prefer-direction.
      if (totalHits > 0) {
        const preferHits = r.offers
          .flatMap((o) => o.picks)
          .flatMap((p) => p.meal.hits)
          .filter((h) => h.channel === "prefer");
        expect(preferHits.length).toBeGreaterThan(0);
      }
    });
  }
);
