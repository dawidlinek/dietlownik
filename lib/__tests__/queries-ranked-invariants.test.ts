import { beforeAll, describe, expect, it, vi } from "vitest";

// Mirrors the other DB-backed ranking suites — see queries-ranked.test.ts.
vi.mock("server-only", () => ({}));

const HEAVY_SKIP =
  process.env.SKIP_HEAVY_TESTS === "1" ||
  process.env.DATABASE_URL === undefined ||
  process.env.DATABASE_URL === "";

/**
 * Scoring invariants that the behavioural suites cannot see.
 *
 * Every one of these guards a bug that shipped and stayed invisible because
 * the tests only ever asserted on ordering and counts:
 *
 *   - `offer_slots_kcal` could emit a (company, dc_id, tier, slot, meal) row
 *     more than once, and `per_option_score` joined it to `all_hits` on a key
 *     without `tier_id`, so each hit was counted N x N times. Scores inflate
 *     quadratically, and inflation only ever promotes — the affected offers
 *     took the whole top 10.
 *   - The embedding channel's penalty ran to 2.0 against a documented 0..1
 *     contract, letting a semantic near-miss outrank an exact ingredient
 *     match and even a hard allergen hit.
 *   - Embedding was suppressed per (meal, keyword) rather than per keyword,
 *     which stripped the bonus from precisely the meals that did contain the
 *     term. `prefer: ['kurczak']` returned zero chicken in the top 10.
 */
describe.skipIf(HEAVY_SKIP)("ranking invariants", () => {
  vi.setConfig({ testTimeout: 180_000 });

  const WROCLAW_ID = 986_283;
  let POPULATED_DATE = "";

  beforeAll(async () => {
    const { resolvePopulatedDate } = await import("./helpers/populated-date");
    POPULATED_DATE = (await resolvePopulatedDate(WROCLAW_ID)) ?? "";
    const mod = await import("../preference-router.js");
    mod.resetTaxonomyCache();
  });

  it("emits each hit once per (slot, meal, source, keyword, channel)", async () => {
    const { getRankedOffersForDay } = await import("../queries.js");
    const { offers } = await getRankedOffersForDay({
      avoid: ["pomidor", "gluten", "psiankowate"],
      cityId: WROCLAW_ID,
      date: POPULATED_DATE,
      limit: 10,
      prefer: ["kurczak", "dużo białka"],
    });
    expect(offers.length).toBeGreaterThan(0);

    for (const offer of offers) {
      for (const pick of offer.picks) {
        const seen = new Set<string>();
        for (const hit of pick.meal.hits) {
          const key = `${hit.source}|${hit.keyword}|${hit.channel}`;
          expect(
            seen.has(key),
            `duplicate ${key} on "${pick.meal.meal_name}" in ${offer.offer_id}`
          ).toBe(false);
          seen.add(key);
        }
      }
    }
  });

  it("keeps every penalty inside the documented 0..1 range", async () => {
    const { getRankedOffersForDay } = await import("../queries.js");
    const { offers } = await getRankedOffersForDay({
      avoid: ["gluten"],
      cityId: WROCLAW_ID,
      date: POPULATED_DATE,
      limit: 10,
      // 'koktajl' reaches the embedding channel; 'pomidor' the lexical one.
      prefer: ["koktajl", "pomidor"],
    });

    const penalties = offers.flatMap((o) =>
      o.picks.flatMap((p) => p.meal.hits.map((h) => h.penalty))
    );
    expect(penalties.length).toBeGreaterThan(0);
    for (const penalty of penalties) {
      expect(penalty).toBeGreaterThanOrEqual(0);
      expect(penalty).toBeLessThanOrEqual(1);
    }
  });

  it("drops the embedding channel for a keyword the lexical channel matched", async () => {
    const { getRankedOffersForDay } = await import("../queries.js");
    const { offers } = await getRankedOffersForDay({
      avoid: [],
      cityId: WROCLAW_ID,
      date: POPULATED_DATE,
      limit: 25,
      prefer: ["kurczak"],
    });

    const bySource = offers.flatMap((o) =>
      o.picks.flatMap((p) =>
        p.meal.hits.filter((h) => h.keyword === "kurczak").map((h) => h.source)
      )
    );
    expect(bySource.length).toBeGreaterThan(0);
    // 'kurczak' is a literal ingredient name; lexical owns it outright.
    expect(bySource).not.toContain("embedding");
  });

  it("surfaces the preferred ingredient in the top offers", async () => {
    const { getRankedOffersForDay } = await import("../queries.js");
    const { offers } = await getRankedOffersForDay({
      avoid: [],
      cityId: WROCLAW_ID,
      date: POPULATED_DATE,
      limit: 10,
      prefer: ["kurczak"],
    });
    expect(offers.length).toBeGreaterThan(0);

    const withChicken = offers.filter((o) =>
      o.picks.some((p) =>
        /kurczak/iu.test(`${p.meal.meal_name} ${p.meal.ingredients_raw ?? ""}`)
      )
    );
    // Was 0/10 before the N-squared fix, with one catering taking every slot.
    expect(withChicken.length).toBeGreaterThan(offers.length / 2);
  });

  it("caps how many offers a single catering takes in a limited result", async () => {
    const { getRankedOffersForDay } = await import("../queries.js");
    const { offers } = await getRankedOffersForDay({
      avoid: [],
      cityId: WROCLAW_ID,
      date: POPULATED_DATE,
      limit: 10,
      prefer: ["kurczak"],
    });

    const perCompany = new Map<string, number>();
    for (const offer of offers) {
      perCompany.set(
        offer.company.id,
        (perCompany.get(offer.company.id) ?? 0) + 1
      );
    }
    for (const [companyId, count] of perCompany) {
      expect(
        count,
        `${companyId} took ${count} of the top 10`
      ).toBeLessThanOrEqual(3);
    }
    expect(perCompany.size).toBeGreaterThan(1);
  });

  it("leaves the unlimited pool uncapped", async () => {
    const { getRankedOffersForDay } = await import("../queries.js");
    const { offers, considered_count } = await getRankedOffersForDay({
      avoid: [],
      cityId: WROCLAW_ID,
      date: POPULATED_DATE,
      limit: 0,
      prefer: [],
    });
    // limit=0 backs the home-page scatter, which needs every offer.
    expect(offers.length).toBe(considered_count);
  });
});
