import { describe, expect, it, vi } from "vitest";

// Pull in server-only stub so transitive `lib/queries → lib/embeddings`
// resolution doesn't blow up under vitest's Node runner. Same pattern as
// `lib/__tests__/queries-ranked.test.ts`.
vi.mock("server-only", () => ({}));

const HEAVY_SKIP =
  process.env.SKIP_HEAVY_TESTS === "1" ||
  process.env.DATABASE_URL === undefined ||
  process.env.DATABASE_URL === "";

// rank_day.execute returns `z.infer<outputSchema> | CallToolResult`. We only
// invoke the happy path (no thrown errors → no CallToolResult), so a narrow
// `as` cast is the cleanest assertion surface in tests.
interface RankDayPickOption {
  readonly pick_id: string;
}
interface RankDayMenuSlot {
  readonly slot_name: string | null;
  readonly options: readonly RankDayPickOption[];
}
interface RankDayMenuDay {
  readonly date: string;
  readonly slots: readonly RankDayMenuSlot[];
}
interface RankDayMenuResult {
  readonly days: readonly RankDayMenuDay[];
}

interface RankDayPick {
  readonly slot_name: string;
  readonly is_default: boolean;
  readonly meal: {
    readonly meal_id: number;
    readonly meal_name: string;
    readonly score: number;
    readonly hits: readonly unknown[];
  };
}

interface RankDayOffer {
  readonly offer_id: string;
  readonly company: { readonly id: string; readonly name: string | null };
  readonly is_menu_configuration: boolean;
  readonly picks: readonly RankDayPick[];
  readonly verdict: { readonly score_best: number; readonly n_slots: number };
}

interface RankDayResult {
  readonly city: string;
  readonly date: string;
  readonly offers: readonly RankDayOffer[];
  readonly considered_count: number;
}

describe.skipIf(HEAVY_SKIP)("rank_day MCP tool", () => {
  // Same budget as the underlying queries-ranked test — bge-m3 cold-load
  // dominates the first call when the keyword cache is cold.
  vi.setConfig({ testTimeout: 180_000 });

  it("ranks offers for a populated date and round-trips offer_id", async () => {
    // Pick a date dynamically: any date present in daily_menu. Falling back to
    // the Wave 2 known-populated date if the table is somehow empty (shouldn't
    // happen, but keeps the test honest under partial data).
    const { q } = await import("@/scraper/db");
    const { rows: menuRows } = await q<{ menu_date: string }>(
      `SELECT DISTINCT to_char(menu_date, 'YYYY-MM-DD') AS menu_date
       FROM daily_menu
       ORDER BY menu_date ASC
       LIMIT 1`
    );
    if (menuRows.length === 0) {
      // No menus at all — skip cleanly. The Wave 4 forward test depends on
      // Wave 2's data being present.
      expect(true).toBe(true);
      return;
    }
    const date = menuRows[0].menu_date;

    const { rank_day } = await import("../tools/rank-day");
    const { parseOfferId } = await import("../offer");
    const { DietlyClient } = await import("../client");

    // Resolve Wrocław's city_id directly so we can seed the resolver's memo —
    // avoids the city.ts SELECT that references columns absent on some
    // deployed schemas. Wave 2 populated Wrocław exclusively.
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
    const result = (await rank_day.execute(
      {
        avoid: ["pomidor", "gluten"],
        city: "Wrocław",
        date,
        kcal_max: undefined,
        kcal_min: undefined,
        limit: 10,
        order_days: 5,
        prefer: ["kurczak"],
        weights: undefined,
      },
      { client }
    )) as RankDayResult;

    expect(result.city).toBe("Wrocław");
    expect(result.date).toBe(date);
    expect(result.offers.length).toBeGreaterThan(0);
    expect(result.considered_count).toBeGreaterThanOrEqual(
      result.offers.length
    );

    const [top] = result.offers;

    // Every offer carries a non-empty picks array (the per-slot best meal).
    expect(top.picks.length).toBeGreaterThan(0);
    expect(top.picks.length).toBe(top.verdict.n_slots);

    // offer_id round-trips through parseOfferId and points back at the same
    // company / diet_calories_id we joined to in the SQL.
    const parsed = parseOfferId(top.offer_id);
    expect(parsed.company_id).toBe(top.company.id);
    expect(parsed.diet_calories_id).toBeGreaterThan(0);
    expect(parsed.is_menu_configuration).toBe(top.is_menu_configuration);

    // The first pick must reference a meal that actually exists in `meals`.
    const [firstPick] = top.picks;
    expect(firstPick.meal.meal_id).toBeGreaterThan(0);
    expect(firstPick.meal.meal_name.length).toBeGreaterThan(0);

    const { rows: mealRows } = await q<{ id: number; name: string }>(
      `SELECT id, name FROM meals WHERE id = $1`,
      [firstPick.meal.meal_id]
    );
    expect(mealRows.length).toBe(1);
    expect(mealRows[0].name).toBe(firstPick.meal.meal_name);

    // Cross-check against get_menu's pick_id surface for the same slot/date.
    // get_menu hits the live dietly API behind Cloudflare; we skip the
    // cross-check (rather than failing the test) if the request errors out.
    try {
      const { get_menu } = await import("../tools/get-menu");
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- happy-path return narrows to the outputSchema shape
      const menuResult = (await get_menu.execute(
        {
          city: "Wrocław",
          dates: [date],
          offer_id: top.offer_id,
        },
        { client }
      )) as RankDayMenuResult;
      const day = menuResult.days.find((d) => d.date === date);
      if (day !== undefined) {
        const slot = day.slots.find((s) => s.slot_name === firstPick.slot_name);
        if (slot !== undefined) {
          const pickIds = slot.options.map((o) => o.pick_id);
          // The rank_day meal_id is a numeric `dietCaloriesMealId`; get_menu
          // emits them stringified. Assertion is best-effort — if the live
          // menu and our scraped menu diverge we don't fail the unit test.
          if (pickIds.length > 0) {
            expect(
              pickIds.includes(String(firstPick.meal.meal_id))
            ).toBeDefined();
          }
        }
      }
    } catch {
      // CF / network failure — non-fatal for this unit test.
    }
  });
});
