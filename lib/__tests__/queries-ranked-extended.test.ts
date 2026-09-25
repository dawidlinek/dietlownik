import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Live-DB tests: skip in lightweight runs.
const HEAVY_SKIP =
  process.env.SKIP_HEAVY_TESTS === "1" ||
  process.env.DATABASE_URL === undefined ||
  process.env.DATABASE_URL === "";

const WROCLAW_ID = 986_283;

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

describe.skipIf(HEAVY_SKIP)("getRankedOffersForDay — channel mechanics", () => {
  vi.setConfig({ testTimeout: 240_000 });

  beforeAll(async () => {
    const router = await import("../preference-router.js");
    router.resetTaxonomyCache();
  });

  // ── No preferences → no hits, but offers still surface ─────────────────
  it("returns price-ordered offers with score 0 when no preferences are supplied", async () => {
    const { getRankedOffersForDay } = await import("../queries.js");
    const result = await getRankedOffersForDay({
      avoid: [],
      cityId: WROCLAW_ID,
      date: POPULATED_DATE,
      limit: 5,
      prefer: [],
    });
    expect(result.offers.length).toBeGreaterThan(0);
    for (const offer of result.offers) {
      expect(offer.verdict.score_best).toBe(0);
      expect(offer.verdict.score_default).toBe(0);
      for (const pick of offer.picks) {
        expect(pick.meal.score).toBe(0);
        expect(pick.meal.hits).toHaveLength(0);
      }
    }
    // With zero scores, the tiebreaker is price ascending (NULLS LAST).
    const prices = result.offers.map((o) => o.price_per_day);
    const numeric = prices.filter((p): p is number => p !== null);
    const sorted = [...numeric].toSorted((a, b) => a - b);
    expect(numeric).toEqual(sorted);
  });

  // ── prefer alone → positive scores; avoid alone → negative ─────────────
  it("produces non-negative scores under prefer-only input", async () => {
    const { getRankedOffersForDay } = await import("../queries.js");
    const result = await getRankedOffersForDay({
      avoid: [],
      cityId: WROCLAW_ID,
      date: POPULATED_DATE,
      prefer: ["kurczak", "dużo białka"],
    });
    expect(result.offers.length).toBeGreaterThan(0);
    // The TOP offer (sorted by score_best DESC) should be ≥ 0 by construction.
    const [top] = result.offers;
    expect(top.verdict.score_best).toBeGreaterThanOrEqual(0);
    // Every hit on the top offer's picks is from a 'prefer' channel.
    for (const pick of top.picks) {
      for (const hit of pick.meal.hits) {
        expect(hit.channel).toBe("prefer");
        expect(hit.contribution).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("produces non-positive scores under avoid-only input on the worst offer", async () => {
    const { getRankedOffersForDay } = await import("../queries.js");
    const result = await getRankedOffersForDay({
      avoid: ["gluten", "psiankowate", "pomidor"],
      cityId: WROCLAW_ID,
      date: POPULATED_DATE,
      limit: 20,
      prefer: [],
    });
    expect(result.offers.length).toBeGreaterThan(0);
    // The bottom offer should be ≤ 0 (avoid-only inputs cannot net positive).
    const last = result.offers.at(-1);
    if (last === undefined) {
      return;
    }
    expect(last.verdict.score_best).toBeLessThanOrEqual(0);
    for (const pick of last.picks) {
      for (const hit of pick.meal.hits) {
        expect(hit.channel).toBe("avoid");
        expect(hit.contribution).toBeLessThanOrEqual(0);
      }
    }
  });

  // ── Weight overrides change the ordering ──────────────────────────────
  it("amplifies avoid impact when weights.avoid is raised", async () => {
    const { getRankedOffersForDay } = await import("../queries.js");
    const base = await getRankedOffersForDay({
      avoid: ["gluten"],
      cityId: WROCLAW_ID,
      date: POPULATED_DATE,
      limit: 20,
      prefer: ["kurczak"],
    });
    const punished = await getRankedOffersForDay({
      avoid: ["gluten"],
      cityId: WROCLAW_ID,
      date: POPULATED_DATE,
      limit: 20,
      prefer: ["kurczak"],
      weights: { avoid: 10, prefer: 1 },
    });

    // A meal that has gluten on EVERY slot with W_AVOID=10 must score ≤ same
    // meal with W_AVOID=1. Compare the lowest score_best in each run as a
    // monotonicity proxy — the strict-stronger-avoid run should reach lower.
    const baseMin = Math.min(...base.offers.map((o) => o.verdict.score_best));
    const punishedMin = Math.min(
      ...punished.offers.map((o) => o.verdict.score_best)
    );
    expect(punishedMin).toBeLessThanOrEqual(baseMin);
  });

  it("amplifies prefer impact when weights.prefer is raised", async () => {
    const { getRankedOffersForDay } = await import("../queries.js");
    const base = await getRankedOffersForDay({
      avoid: ["pomidor"],
      cityId: WROCLAW_ID,
      date: POPULATED_DATE,
      limit: 20,
      prefer: ["kurczak"],
    });
    const boosted = await getRankedOffersForDay({
      avoid: ["pomidor"],
      cityId: WROCLAW_ID,
      date: POPULATED_DATE,
      limit: 20,
      prefer: ["kurczak"],
      weights: { avoid: 1, prefer: 10 },
    });

    const baseMax = Math.max(...base.offers.map((o) => o.verdict.score_best));
    const boostedMax = Math.max(
      ...boosted.offers.map((o) => o.verdict.score_best)
    );
    expect(boostedMax).toBeGreaterThanOrEqual(baseMax);
  });

  // ── Same keyword in both channels nets out ────────────────────────────
  it("nets a keyword that appears in both prefer and avoid", async () => {
    const { getRankedOffersForDay } = await import("../queries.js");
    const onlyPrefer = await getRankedOffersForDay({
      avoid: [],
      cityId: WROCLAW_ID,
      date: POPULATED_DATE,
      limit: 1,
      prefer: ["kurczak"],
    });
    const both = await getRankedOffersForDay({
      avoid: ["kurczak"],
      cityId: WROCLAW_ID,
      date: POPULATED_DATE,
      limit: 1,
      prefer: ["kurczak"],
    });
    // 'both' must score ≤ 'onlyPrefer' on the same top offer — the avoid
    // contribution can only subtract.
    if (onlyPrefer.offers.length > 0 && both.offers.length > 0) {
      expect(both.offers[0].verdict.score_best).toBeLessThanOrEqual(
        onlyPrefer.offers[0].verdict.score_best
      );
    }
  });

  // ── kcal filtering is strict ──────────────────────────────────────────
  it("filters strictly by kcal bounds at both edges", async () => {
    const { getRankedOffersForDay } = await import("../queries.js");
    const lo = 1200;
    const hi = 1500;
    const result = await getRankedOffersForDay({
      avoid: [],
      cityId: WROCLAW_ID,
      date: POPULATED_DATE,
      kcalMax: hi,
      kcalMin: lo,
      limit: 50,
      prefer: [],
    });
    for (const offer of result.offers) {
      if (offer.calories !== null) {
        expect(offer.calories).toBeGreaterThanOrEqual(lo);
        expect(offer.calories).toBeLessThanOrEqual(hi);
      }
    }
  });

  // ── limit honored, considered_count is the full population ───────────
  it("respects limit but reports the full considered_count", async () => {
    const { getRankedOffersForDay } = await import("../queries.js");
    const result = await getRankedOffersForDay({
      avoid: [],
      cityId: WROCLAW_ID,
      date: POPULATED_DATE,
      limit: 3,
      prefer: ["kurczak"],
    });
    expect(result.offers.length).toBeLessThanOrEqual(3);
    expect(result.considered_count).toBeGreaterThanOrEqual(
      result.offers.length
    );
  });

  // ── Determinism ───────────────────────────────────────────────────────
  it("returns identical results across repeated identical calls", async () => {
    const { getRankedOffersForDay } = await import("../queries.js");
    const a = await getRankedOffersForDay({
      avoid: ["pomidor"],
      cityId: WROCLAW_ID,
      date: POPULATED_DATE,
      limit: 5,
      prefer: ["kurczak"],
    });
    const b = await getRankedOffersForDay({
      avoid: ["pomidor"],
      cityId: WROCLAW_ID,
      date: POPULATED_DATE,
      limit: 5,
      prefer: ["kurczak"],
    });
    expect(a.considered_count).toBe(b.considered_count);
    expect(a.offers.map((o) => o.offer_id)).toEqual(
      b.offers.map((o) => o.offer_id)
    );
    expect(a.offers.map((o) => o.verdict.score_best)).toEqual(
      b.offers.map((o) => o.verdict.score_best)
    );
  });

  // ── Hit attribution: each source reports what it matched ─────────────
  it("attributes allergen hits to the meal's allergens list", async () => {
    const { getRankedOffersForDay } = await import("../queries.js");
    const result = await getRankedOffersForDay({
      avoid: ["gluten"],
      cityId: WROCLAW_ID,
      date: POPULATED_DATE,
      limit: 20,
      prefer: [],
    });
    const allergenHits = result.offers
      .flatMap((o) => o.picks)
      .flatMap((p) => p.meal.hits)
      .filter((h) => h.source === "allergen");
    if (allergenHits.length > 0) {
      for (const hit of allergenHits) {
        expect(hit.channel).toBe("avoid");
        expect(hit.reason.toLowerCase()).toContain("gluten");
        expect(hit.penalty).toBe(1);
      }
    }
  });

  it("attributes category hits via taxonomy ingredient patterns", async () => {
    const { getRankedOffersForDay } = await import("../queries.js");
    const result = await getRankedOffersForDay({
      avoid: ["psiankowate"],
      cityId: WROCLAW_ID,
      date: POPULATED_DATE,
      limit: 20,
      prefer: [],
    });
    const catHits = result.offers
      .flatMap((o) => o.picks)
      .flatMap((p) => p.meal.hits)
      .filter((h) => h.source === "category");
    if (catHits.length > 0) {
      for (const hit of catHits) {
        expect(hit.channel).toBe("avoid");
        expect(hit.reason.toLowerCase()).toContain("psiankowate");
        expect(hit.penalty).toBe(1);
      }
    }
  });

  it("attributes macro hits with the field that matched", async () => {
    const { getRankedOffersForDay } = await import("../queries.js");
    const result = await getRankedOffersForDay({
      avoid: [],
      cityId: WROCLAW_ID,
      date: POPULATED_DATE,
      limit: 20,
      prefer: ["dużo białka"],
    });
    const macroHits = result.offers
      .flatMap((o) => o.picks)
      .flatMap((p) => p.meal.hits)
      .filter((h) => h.source === "macro");
    if (macroHits.length > 0) {
      for (const hit of macroHits) {
        expect(hit.channel).toBe("prefer");
        // Reason should reference either the macro name or 'protein'.
        const r = hit.reason.toLowerCase();
        expect(
          r.includes("protein") || r.includes("białk") || r.includes("bialk")
        ).toBe(true);
      }
    }
  });

  it("attributes embedding hits with a similarity score in (0, 1]", async () => {
    const { getRankedOffersForDay } = await import("../queries.js");
    const result = await getRankedOffersForDay({
      avoid: [],
      cityId: WROCLAW_ID,
      date: POPULATED_DATE,
      limit: 20,
      // NOT 'kurczak' — the embedding channel is a fallback now, and the
      // lexical channel owns any keyword that is a literal ingredient or
      // dish word. An English phrase reaches no Polish ingredient name via
      // word_similarity, so it is a stable way to exercise the vector path.
      prefer: ["comfort food"],
    });
    const embHits = result.offers
      .flatMap((o) => o.picks)
      .flatMap((p) => p.meal.hits)
      .filter((h) => h.source === "embedding");
    expect(embHits.length).toBeGreaterThan(0);
    for (const hit of embHits) {
      expect(hit.penalty).toBeGreaterThan(0);
      expect(hit.penalty).toBeLessThanOrEqual(1);
      expect(hit.reason.toLowerCase()).toContain("sim=");
    }
  });

  // ── picks_default semantics for menu-config vs fixed ─────────────────
  it("exposes picks_default for menu-config offers when scoring differs", async () => {
    const { getRankedOffersForDay } = await import("../queries.js");
    const result = await getRankedOffersForDay({
      avoid: ["gluten"],
      cityId: WROCLAW_ID,
      date: POPULATED_DATE,
      limit: 30,
      prefer: ["kurczak"],
    });
    const configurable = result.offers.filter((o) => o.is_menu_configuration);
    for (const offer of configurable) {
      // For menu-config offers, picks_default is either null (best ≡ default)
      // or an array matching the slot count.
      if (offer.picks_default !== null) {
        expect(offer.picks_default.length).toBe(offer.picks.length);
        expect(offer.verdict.score_best).toBeGreaterThanOrEqual(
          offer.verdict.score_default
        );
      }
    }
    const fixed = result.offers.filter((o) => !o.is_menu_configuration);
    for (const offer of fixed) {
      expect(offer.picks_default).toBeNull();
      expect(offer.verdict.score_best).toBeCloseTo(
        offer.verdict.score_default,
        5
      );
    }
  });

  // ── order_days is a soft preference, never a filter ────────────────────
  //
  // This project orders DAY BY DAY and mixes suppliers to win each day on its
  // own merits (e.g. best protein/zł), so the scraper captures only the 1-day
  // no-discount baseline (ORDER_DAY_TIERS=[1] in scraper/scrapers/prices.ts).
  //
  // The previous test here asserted the opposite — that varying orderDays
  // yields different per-day prices — which can only hold under the legacy
  // [1,5,10,20] sweep. It failed permanently once the 1-tier default landed.
  // What actually matters is that order-days never filters an offer out of
  // the results: a hard `order_days = N` predicate silently nulled every
  // price (and that bug is still live in some call sites' history).
  it("prices every offer regardless of orderDays under a single-tier corpus", async () => {
    const { getRankedOffersForDay } = await import("../queries.js");
    const base = {
      avoid: [],
      cityId: WROCLAW_ID,
      date: POPULATED_DATE,
      limit: 50,
      prefer: [],
    };
    // Spelled out rather than mapped: an arrow returning a promise trips
    // `promise-function-async`, and the `await` that satisfies it is stripped
    // by the formatter and then flagged by `return-await`.
    const runs = await Promise.all([
      getRankedOffersForDay({ ...base, orderDays: 1 }),
      getRankedOffersForDay({ ...base, orderDays: 5 }),
      getRankedOffersForDay({ ...base, orderDays: 20 }),
    ]);

    for (const run of runs) {
      expect(run.offers.length).toBeGreaterThan(0);
      // No orderDays value may starve an offer of its price.
      const priced = run.offers.filter((o) => o.price_per_day !== null);
      expect(priced.length).toBe(run.offers.length);
      for (const offer of priced) {
        expect(offer.price_per_day).toBeGreaterThan(0);
      }
    }

    // The same offers come back whichever duration is requested — the
    // preference may reorder ties, but it must never change the population.
    const idSets = runs.map((r) => new Set(r.offers.map((o) => o.offer_id)));
    const [first] = idSets;
    for (const ids of idSets.slice(1)) {
      expect(ids.size).toBe(first.size);
    }
  });
});

describe.skipIf(HEAVY_SKIP)("getWeeklyPlan — argmax + summary", () => {
  vi.setConfig({ testTimeout: 240_000 });

  it("argmaxes per-day independently and matches rank_day standalone", async () => {
    const { getRankedOffersForDay, getWeeklyPlan } =
      await import("../queries.js");
    const dates = POPULATED_DATES.slice(0, 2);
    const plan = await getWeeklyPlan({
      altLimit: 0,
      avoid: ["pomidor"],
      cityId: WROCLAW_ID,
      dates: [...dates],
      prefer: ["kurczak"],
    });
    for (const day of plan.days) {
      if (day.top === null) {
        continue;
      }
      const stand = await getRankedOffersForDay({
        avoid: ["pomidor"],
        cityId: WROCLAW_ID,
        date: day.date,
        limit: 1,
        prefer: ["kurczak"],
      });
      expect(stand.offers).toHaveLength(1);
      expect(stand.offers[0].offer_id).toBe(day.top.offer_id);
      expect(stand.offers[0].verdict.score_best).toBeCloseTo(
        day.top.verdict.score_best,
        5
      );
    }
  });

  it("counts distinct caterings correctly", async () => {
    const { getWeeklyPlan } = await import("../queries.js");
    const dates = POPULATED_DATES.slice(0, 3);
    const plan = await getWeeklyPlan({
      altLimit: 0,
      avoid: [],
      cityId: WROCLAW_ID,
      dates: [...dates],
      prefer: [],
    });
    const ids = new Set(
      plan.days
        .map((d) => d.top?.company.id)
        .filter((s): s is string => typeof s === "string")
    );
    expect(plan.summary.distinct_caterings).toBe(ids.size);
  });

  it("estimates total price as the sum of per-day picks", async () => {
    const { getWeeklyPlan } = await import("../queries.js");
    const dates = POPULATED_DATES.slice(0, 2);
    const plan = await getWeeklyPlan({
      altLimit: 0,
      avoid: [],
      cityId: WROCLAW_ID,
      dates: [...dates],
      prefer: [],
    });
    const manual = plan.days.reduce(
      (acc, d) => acc + (d.top?.price_per_day ?? 0),
      0
    );
    expect(plan.summary.estimated_total_price).toBeCloseTo(manual, 2);
  });

  it("computes avg_score_best as the mean of present tops", async () => {
    const { getWeeklyPlan } = await import("../queries.js");
    const dates = POPULATED_DATES.slice(0, 2);
    const plan = await getWeeklyPlan({
      altLimit: 0,
      avoid: ["pomidor"],
      cityId: WROCLAW_ID,
      dates: [...dates],
      prefer: ["kurczak"],
    });
    const scores = plan.days
      .map((d) => d.top?.verdict.score_best)
      .filter((s): s is number => typeof s === "number");
    if (scores.length > 0) {
      const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
      expect(plan.summary.avg_score_best).toBeCloseTo(mean, 5);
    }
  });

  it("marks date with no menus with the expected note", async () => {
    const { getWeeklyPlan } = await import("../queries.js");
    const plan = await getWeeklyPlan({
      altLimit: 0,
      avoid: [],
      cityId: WROCLAW_ID,
      dates: ["1999-01-01"],
      prefer: [],
    });
    expect(plan.days).toHaveLength(1);
    expect(plan.days[0].top).toBeNull();
    expect(plan.days[0].note).toBe("no menus captured for this date");
  });
});
