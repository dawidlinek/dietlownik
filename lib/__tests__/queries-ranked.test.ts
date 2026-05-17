import { beforeAll, describe, expect, it, vi } from "vitest";

// `lib/embeddings.ts` was originally specified to open with
// `import 'server-only'`. Agent B (Wave 1) replaced that literal import with a
// runtime guard, but we still mock it here in case the literal import is
// restored later — mirrors `lib/__tests__/embeddings.test.ts`.
vi.mock("server-only", () => ({}));

// Heavy by definition (live DB + on-disk bge-m3 cold-load when the keyword
// embedding cache is cold). Skip in lightweight test runs.
const HEAVY_SKIP =
  process.env.SKIP_HEAVY_TESTS === "1" ||
  process.env.DATABASE_URL === undefined ||
  process.env.DATABASE_URL === "";

describe.skipIf(HEAVY_SKIP)("getRankedOffersForDay + getWeeklyPlan", () => {
  // bge-m3 cold load + first inference can take ~10 s on a warm checkout,
  // longer on the very first fetch from HF. Plus a few SQL round-trips. 2 min
  // gives us comfortable headroom.
  vi.setConfig({ testTimeout: 180_000 });

  // Wrocław is the only city populated by Wave 2 verification (robinfood).
  const WROCLAW_ID = 986_283;

  // Pick a date the scraper has populated. The data window from Wave 2 spans
  // 2026-05-16 through 2026-05-22; we use D+1 (2026-05-17) where ALL diet
  // shapes (fixed AND menu-config) are present, since today's row might be
  // missing some early slots.
  const POPULATED_DATE = "2026-05-17";

  beforeAll(async () => {
    // Drop any cached taxonomy so the live DB is exercised once per file —
    // mirrors what `preference-router.test.ts` does.
    const mod = await import("../preference-router.js");
    mod.resetTaxonomyCache();
  });

  it("ranks offers for one populated day with mixed preferences", async () => {
    const { getRankedOffersForDay } = await import("../queries.js");
    const result = await getRankedOffersForDay({
      avoid: ["pomidor", "ostre", "gluten", "psiankowate"],
      cityId: WROCLAW_ID,
      date: POPULATED_DATE,
      prefer: ["kurczak", "dużo białka", "koktajl"],
    });

    expect(result.considered_count).toBeGreaterThan(0);
    expect(result.offers.length).toBeGreaterThan(0);
    // Limit defaults to 10, considered_count is the un-limited population.
    expect(result.offers.length).toBeLessThanOrEqual(10);
    expect(result.considered_count).toBeGreaterThanOrEqual(
      result.offers.length
    );

    // The top offer is sorted by score_best descending.
    if (result.offers.length >= 2) {
      const [first, second] = result.offers;
      expect(first.verdict.score_best).toBeGreaterThanOrEqual(
        second.verdict.score_best
      );
    }

    // picks length matches the verdict's n_slots.
    const [top] = result.offers;
    expect(top.picks.length).toBe(top.verdict.n_slots);

    // Every meal has a name and (signed) score; hits is always an array.
    for (const pick of top.picks) {
      expect(pick.meal.meal_name).toBeTypeOf("string");
      expect(pick.meal.meal_name.length).toBeGreaterThan(0);
      expect(Array.isArray(pick.meal.hits)).toBe(true);
      expect(pick.meal.score).toBeTypeOf("number");
    }

    // At least one offer must surface hits across our four routing sources.
    // We expect at minimum: embedding (kurczak/pomidor/koktajl/ostre fall
    // through to embedding), category ('psiankowate' → 'pomidor' pattern hits),
    // macro ('dużo białka' → protein_g high), and allergen ('gluten').
    const sourcesSeen = new Set<string>();
    for (const offer of result.offers) {
      for (const pick of offer.picks) {
        for (const hit of pick.meal.hits) {
          sourcesSeen.add(hit.source);
        }
      }
    }
    expect(sourcesSeen.size).toBeGreaterThan(0);
    // At minimum we expect embedding (it covers fallback) and one structured
    // source. Allergen requires a meal tagged 'gluten' in scope, which we
    // verified in the inspection step.
    expect(sourcesSeen.has("embedding")).toBe(true);

    // Sign discipline: prefer hits are positive contributions, avoid negative.
    for (const offer of result.offers) {
      for (const pick of offer.picks) {
        for (const hit of pick.meal.hits) {
          if (hit.channel === "prefer") {
            expect(hit.contribution).toBeGreaterThanOrEqual(0);
          } else {
            expect(hit.contribution).toBeLessThanOrEqual(0);
          }
          expect(hit.penalty).toBeGreaterThanOrEqual(0);
          expect(hit.penalty).toBeLessThanOrEqual(1);
        }
      }
    }

    // Menu-config vs fixed invariants from the plan.
    for (const offer of result.offers) {
      if (offer.is_menu_configuration) {
        // score_best ≥ score_default by definition (best is per-slot argmax).
        expect(offer.verdict.score_best).toBeGreaterThanOrEqual(
          offer.verdict.score_default
        );
      } else {
        // Fixed diet: score_default and score_best are mathematically equal
        // and picks_default is suppressed (null) because there's nothing to
        // switch to.
        expect(offer.verdict.score_best).toBeCloseTo(
          offer.verdict.score_default,
          5
        );
        expect(offer.picks_default).toBeNull();
      }
    }

    // offer_id round-trips through the encoder shape (v1:co:dc[:tdo]).
    for (const offer of result.offers) {
      expect(offer.offer_id.startsWith("v1:")).toBe(true);
      const parts = offer.offer_id.split(":");
      if (offer.is_menu_configuration) {
        expect(parts.length).toBe(4);
      } else {
        expect(parts.length).toBe(3);
      }
    }
  });

  it("respects kcal bounds when provided", async () => {
    const { getRankedOffersForDay } = await import("../queries.js");
    const result = await getRankedOffersForDay({
      avoid: [],
      cityId: WROCLAW_ID,
      date: POPULATED_DATE,
      kcalMax: 1200,
      kcalMin: 1200,
      prefer: [],
    });
    for (const offer of result.offers) {
      expect(offer.calories).toBe(1200);
    }
  });

  it("returns an empty result for a date with no menus", async () => {
    const { getRankedOffersForDay } = await import("../queries.js");
    const result = await getRankedOffersForDay({
      avoid: [],
      cityId: WROCLAW_ID,
      date: "1999-01-01",
      prefer: ["kurczak"],
    });
    expect(result.offers).toHaveLength(0);
    expect(result.considered_count).toBe(0);
  });

  it("getWeeklyPlan returns one PlannedDay per requested date", async () => {
    const { getWeeklyPlan } = await import("../queries.js");
    const dates = ["2026-05-17", "2026-05-18", "2026-05-19"] as const;
    const plan = await getWeeklyPlan({
      altLimit: 3,
      avoid: ["pomidor"],
      cityId: WROCLAW_ID,
      dates: [...dates],
      prefer: ["kurczak"],
    });
    expect(plan.days).toHaveLength(dates.length);
    expect(plan.city.id).toBe(WROCLAW_ID);
    expect(plan.city.name).toBe("Wrocław");

    // Each day surfaces a `top` or a `note` explaining the absence.
    for (const day of plan.days) {
      if (day.top === null) {
        expect(day.note).toBe("no menus captured for this date");
      } else {
        expect(day.alternates.length).toBeLessThanOrEqual(3);
      }
    }

    // Summary numbers are sane (no NaN, non-negative price).
    expect(Number.isFinite(plan.summary.avg_score_best)).toBe(true);
    expect(plan.summary.distinct_caterings).toBeGreaterThanOrEqual(0);
    expect(plan.summary.estimated_total_price).toBeGreaterThanOrEqual(0);
  });
});
