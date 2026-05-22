import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const HEAVY_SKIP =
  process.env.SKIP_HEAVY_TESTS === "1" ||
  process.env.DATABASE_URL === undefined ||
  process.env.DATABASE_URL === "";

// Narrow shapes for the happy-path return values of plan_week.execute and
// rank_day.execute (which otherwise come back as `T | CallToolResult`). The
// dispatcher revalidates against the same Zod schemas at runtime; these
// interfaces are local sugar for the assertions.
interface PlanOffer {
  readonly offer_id: string;
  readonly company: { readonly id: string; readonly name: string | null };
  readonly verdict: { readonly score_best: number };
}
interface PlannedDay {
  readonly date: string;
  readonly top: PlanOffer | null;
  readonly alternates: readonly PlanOffer[];
  readonly note: string | null;
}
interface PlanWeekResult {
  readonly city: { readonly id: number; readonly name: string };
  readonly days: readonly PlannedDay[];
  readonly summary: {
    readonly avg_score_best: number;
    readonly distinct_caterings: number;
    readonly estimated_total_price: number;
    readonly bundle_hint: string | null;
  };
}
interface RankDayResult {
  readonly offers: readonly PlanOffer[];
}

describe.skipIf(HEAVY_SKIP)("plan_week MCP tool", () => {
  // Per-day fan-out × 5 dates × bge-m3 cold-load possibility. Same headroom
  // as the rank_day unit test.
  vi.setConfig({ testTimeout: 240_000 });

  it("plans a 5-day window with consistent top picks and summary stats", async () => {
    const { q } = await import("@/scraper/db");
    const { rows: menuRows } = await q<{ menu_date: string }>(
      `SELECT DISTINCT to_char(menu_date, 'YYYY-MM-DD') AS menu_date
       FROM daily_menu
       ORDER BY menu_date ASC
       LIMIT 5`
    );
    if (menuRows.length === 0) {
      expect(true).toBe(true);
      return;
    }
    const dates = menuRows.map(
      (r: Readonly<{ menu_date: string }>) => r.menu_date
    );

    const { plan_week } = await import("../tools/plan-week");
    const { rank_day } = await import("../tools/rank-day");
    const { DietlyClient } = await import("../client");

    // Resolve city_id directly to bypass the legacy city.ts SELECT.
    const { rows: cityRows } = await q<{ city_id: number | string }>(
      `SELECT city_id FROM cities WHERE name = $1 LIMIT 1`,
      ["Wrocław"]
    );
    expect(cityRows.length).toBe(1);
    const cityId = Number(cityRows[0].city_id);

    const client = new DietlyClient();
    interface WithMemo {
      readonly memo: Map<string, { id: number; name: string }>;
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- seed the private memo so resolve() short-circuits past the legacy SQL that references columns absent on some deployed schemas
    const { memo } = client.cities as unknown as WithMemo;
    memo.set("wrocław", { id: cityId, name: "Wrocław" });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- happy-path return narrows to the outputSchema shape; CallToolResult is only returned on thrown error
    const plan = (await plan_week.execute(
      {
        alt_limit: 3,
        avoid: ["pomidor", "gluten"],
        city: "Wrocław",
        dates,
        kcal_max: undefined,
        kcal_min: undefined,
        prefer: ["kurczak"],
        weights: undefined,
      },
      { client }
    )) as PlanWeekResult;

    expect(plan.city.name).toBe("Wrocław");
    expect(plan.days.length).toBe(dates.length);
    for (let i = 0; i < dates.length; i += 1) {
      expect(plan.days[i].date).toBe(dates[i]);
    }

    // Spot-check: invoking rank_day standalone for the same date should yield
    // the same top offer_id (modulo ties; tiebreakers in SQL are deterministic).
    const [sampleDate] = dates;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- happy-path return
    const standalone = (await rank_day.execute(
      {
        avoid: ["pomidor", "gluten"],
        city: "Wrocław",
        date: sampleDate,
        kcal_max: undefined,
        kcal_min: undefined,
        // Same per-day limit plan_week uses internally (altLimit + 1 = 4).
        limit: 4,
        order_days: 5,
        prefer: ["kurczak"],
        weights: undefined,
      },
      { client }
    )) as RankDayResult;
    const planDay = plan.days.find((d) => d.date === sampleDate);
    expect(planDay).toBeDefined();
    if (
      planDay !== undefined &&
      planDay.top !== null &&
      standalone.offers.length > 0
    ) {
      expect(planDay.top.offer_id).toBe(standalone.offers[0].offer_id);
    }

    // Summary aggregates: average score_best across days that have a top
    // matches the on-the-fly mean (within float epsilon).
    type PlannedDayWithTop = PlannedDay & { readonly top: PlanOffer };
    const withTop: readonly PlannedDayWithTop[] = plan.days.filter(
      (d): d is PlannedDayWithTop => d.top !== null
    );
    if (withTop.length > 0) {
      const expectedAvg =
        withTop.reduce(
          (acc: number, d: PlannedDayWithTop) => acc + d.top.verdict.score_best,
          0
        ) / withTop.length;
      expect(plan.summary.avg_score_best).toBeCloseTo(expectedAvg, 5);
      expect(plan.summary.distinct_caterings).toBeGreaterThanOrEqual(1);
    } else {
      // No days with a top — average defaults to 0; distinct_caterings = 0.
      expect(plan.summary.avg_score_best).toBe(0);
      expect(plan.summary.distinct_caterings).toBe(0);
    }
  });
});
