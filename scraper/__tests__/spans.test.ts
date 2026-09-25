import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { q as dbQuery } from "@/scraper/db";
import type { MealFields, MenuObservation } from "@/scraper/scrapers/menus";
import type { DeepReadonly } from "@/scraper/types";

// A dietary_exclusions id no real dietly entry uses; the dictionary keeps the
// first name it sees, so a real id would read back dietly's name instead.
const TEST_EXCLUSION = 999_999_901;

const DB_SKIP =
  process.env.DATABASE_URL === undefined || process.env.DATABASE_URL === "";

const fields = (
  overrides: DeepReadonly<Partial<MealFields>> = {}
): DeepReadonly<MealFields> => ({
  allergens: ["Mleko"],
  allergens_detail: [
    { company_name: "MLEKO", dietly_name: "Mleko", id: TEST_EXCLUSION },
  ],
  api_meal_slot_id: 0,
  carbs_g: 30,
  exclusions: [[TEST_EXCLUSION, "mleko"]],
  fat_g: 10,
  fiber_g: 3,
  image_url: null,
  ingredients: [
    {
      exclusion_ids: [TEST_EXCLUSION],
      is_major: true,
      name_normalized: "mleko",
      name_raw: "Mleko",
      position: 1,
    },
    {
      exclusion_ids: [],
      is_major: false,
      name_normalized: "platki owsiane",
      name_raw: "Płatki owsiane",
      position: 2,
    },
  ],
  ingredients_raw: "Mleko; Płatki owsiane",
  kcal: 400,
  label: null,
  name: "Owsianka",
  protein_g: 20,
  reviews_number: 10,
  reviews_score: 4.5,
  salt_g: 0.2,
  saturated_fat_g: 2,
  sugar_g: 8,
  thermo: null,
  ...overrides,
});

const observation = (
  slotId: number,
  mealId: number,
  variantId: number | null,
  overrides: Readonly<Partial<MenuObservation>> = {}
): MenuObservation => ({
  api_meal_slot_id: slotId,
  carbs_g: 30,
  fat_g: 10,
  fiber_g: 3,
  image_url: null,
  is_default: true,
  kcal: 400,
  meal_id: mealId,
  protein_g: 20,
  reviews_number: 10,
  reviews_score: 4.5,
  salt_g: 0.2,
  saturated_fat_g: 2,
  slot_name: "Śniadanie",
  sugar_g: 8,
  variant_id: variantId,
  ...overrides,
});

const quoteValues = (total: number): unknown[] => [
  total,
  total,
  total,
  null,
  5,
  null,
  0,
  null,
  0,
  0,
  0,
  0,
  0,
  10,
  null,
];

/**
 * The span writers are the only code that turns repeated scrapes into
 * history, and a bug there is silent: it either re-inflates the tables into
 * an event log or quietly merges observations that differed. These tests
 * drive the real writers against the real schema with a throwaway catering,
 * and check every transition: extend, change, disappear, gap, empty fetch.
 *
 * Everything is created under COMPANY and CITY and removed afterwards
 * (company deletes cascade through catalog, meals and both span tables).
 */
describe.skipIf(DB_SKIP)("span writers", () => {
  const COMPANY = "__span_test__";
  const CITY = 999_999_901;
  const DC = 1;
  const DATE = "2099-01-05";
  // Menus are national (v15): the scope has no city. CITY is still used by
  // the price and per-city span tests below.
  const SCOPE = [COMPANY, DC, 0, DATE] as const;

  let q: typeof dbQuery;

  const cleanup = async (): Promise<void> => {
    await q("DELETE FROM companies WHERE company_id = $1", [COMPANY]);
    await q("DELETE FROM cities WHERE city_id = $1", [CITY]);
    await q("DELETE FROM dietary_exclusions WHERE exclusion_id = $1", [
      TEST_EXCLUSION,
    ]);
  };

  beforeAll(async () => {
    ({ q } = await import("@/scraper/db"));
    await cleanup();
    await q("INSERT INTO cities (city_id, name) VALUES ($1, 'Testowo')", [
      CITY,
    ]);
    await q("INSERT INTO companies (company_id, name) VALUES ($1, 'Test')", [
      COMPANY,
    ]);
    await q(
      "INSERT INTO diets (company_id, diet_id, name) VALUES ($1, 1, 'Dieta')",
      [COMPANY]
    );
    await q(
      "INSERT INTO tiers (company_id, diet_id, tier_id, name) VALUES ($1, 1, 0, 'T')",
      [COMPANY]
    );
    await q(
      `INSERT INTO diet_options (company_id, diet_id, tier_id, diet_option_id, name)
       VALUES ($1, 1, 0, 0, 'O')`,
      [COMPANY]
    );
    await q(
      `INSERT INTO diet_calories
         (diet_calories_id, company_id, diet_id, tier_id, diet_option_id, calories)
       VALUES ($1, $2, 1, 0, 0, 1500)`,
      [DC, COMPANY]
    );
    // The same diet_calories_id under a second tier, as menu-configuration
    // diets do for their meal-count packages.
    await q(
      "INSERT INTO tiers (company_id, diet_id, tier_id, name) VALUES ($1, 1, 1, 'T1')",
      [COMPANY]
    );
    await q(
      `INSERT INTO diet_options (company_id, diet_id, tier_id, diet_option_id, name)
       VALUES ($1, 1, 1, 0, 'O')`,
      [COMPANY]
    );
    await q(
      `INSERT INTO diet_calories
         (diet_calories_id, company_id, diet_id, tier_id, diet_option_id, calories)
       VALUES ($1, $2, 1, 1, 0, 1500)`,
      [DC, COMPANY]
    );
  });

  afterAll(async () => {
    await cleanup();
  });

  interface SpanRow {
    api_meal_slot_id: string;
    kcal: string | null;
    observations: number;
    open: boolean;
  }

  const spans = async (): Promise<SpanRow[]> => {
    const { rows } = await q<SpanRow>(
      `SELECT api_meal_slot_id, kcal, observations, closed_at IS NULL AS open
         FROM menu_items WHERE company_id = $1
        ORDER BY api_meal_slot_id, id`,
      [COMPANY]
    );
    return rows;
  };

  let mealId = 0;
  let variantId = 0;

  it("reuses a variant for identical content and hashes like the database", async () => {
    const { upsertMeal, upsertVariant } =
      await import("@/scraper/scrapers/menus");
    mealId = (await upsertMeal(COMPANY, "Owsianka", null)) ?? 0;
    expect(mealId).toBeGreaterThan(0);
    expect(await upsertMeal(COMPANY, "Owsianka", null)).toBe(mealId);

    const first = await upsertVariant(mealId, fields());
    const again = await upsertVariant(mealId, fields());
    expect(first?.inserted).toBe(true);
    expect(again).toEqual({ inserted: false, variant_id: first?.variant_id });
    variantId = first?.variant_id ?? 0;

    const { rows: ing } = await q<{ n: string }>(
      "SELECT count(*) AS n FROM meal_ingredients WHERE variant_id = $1",
      [variantId]
    );
    expect(Number(ing[0]?.n)).toBe(2);

    // Same ingredients, different spelling: that is different content.
    const shouted = await upsertVariant(
      mealId,
      fields({
        ingredients: fields().ingredients.map((i) => ({
          ...i,
          name_raw: i.name_raw.toUpperCase(),
        })),
      })
    );
    expect(shouted?.inserted).toBe(true);
    expect(shouted?.variant_id).not.toBe(variantId);

    // Portion numbers are not content.
    const bigger = await upsertVariant(mealId, fields({ kcal: 800 }));
    expect(bigger?.variant_id).toBe(variantId);
  });

  it("extends a span when the same menu is seen again", async () => {
    const { recordMenu } = await import("@/scraper/scrapers/menus");
    const obs = [
      observation(101, mealId, variantId),
      observation(102, mealId, variantId, { is_default: false }),
    ];
    await recordMenu(SCOPE, obs);
    await recordMenu(SCOPE, obs);
    expect(await spans()).toEqual([
      { api_meal_slot_id: "101", kcal: "400.00", observations: 2, open: true },
      { api_meal_slot_id: "102", kcal: "400.00", observations: 2, open: true },
    ]);
  });

  it("treats a value that rounds to the stored one as unchanged", async () => {
    const { recordMenu } = await import("@/scraper/scrapers/menus");
    await recordMenu(SCOPE, [
      observation(101, mealId, variantId, { kcal: 400.001 }),
      observation(102, mealId, variantId, { is_default: false }),
    ]);
    const rows = await spans();
    expect(rows).toHaveLength(2);
    expect(
      rows.every((r: Readonly<SpanRow>) => r.open && r.observations === 3)
    ).toBe(true);
  });

  it("closes changed and missing options and opens new ones", async () => {
    const { recordMenu } = await import("@/scraper/scrapers/menus");
    await recordMenu(SCOPE, [
      observation(101, mealId, variantId, { kcal: 410 }),
      observation(103, mealId, variantId),
    ]);
    expect(await spans()).toEqual([
      { api_meal_slot_id: "101", kcal: "400.00", observations: 3, open: false },
      { api_meal_slot_id: "101", kcal: "410.00", observations: 1, open: true },
      { api_meal_slot_id: "102", kcal: "400.00", observations: 3, open: false },
      { api_meal_slot_id: "103", kcal: "400.00", observations: 1, open: true },
    ]);
  });

  it("ignores an empty menu instead of closing everything", async () => {
    const { recordMenu } = await import("@/scraper/scrapers/menus");
    await recordMenu(SCOPE, []);
    const rows = await spans();
    const open = rows.filter((r: Readonly<SpanRow>) => r.open);
    expect(open.map((r: Readonly<SpanRow>) => r.api_meal_slot_id)).toEqual([
      "101",
      "103",
    ]);
  });

  it("starts a new span after a silence longer than the gap", async () => {
    const { recordMenu } = await import("@/scraper/scrapers/menus");
    await q(
      `UPDATE menu_items
          SET first_seen_at = first_seen_at - INTERVAL '40 hours',
              last_seen_at  = last_seen_at  - INTERVAL '40 hours'
        WHERE company_id = $1 AND closed_at IS NULL`,
      [COMPANY]
    );
    await recordMenu(SCOPE, [
      observation(101, mealId, variantId, { kcal: 410 }),
      observation(103, mealId, variantId),
    ]);
    const rows = await spans();
    const s101 = rows.filter(
      (r: Readonly<SpanRow>) => r.api_meal_slot_id === "101"
    );
    expect(s101.map((r: Readonly<SpanRow>) => [r.kcal, r.open])).toEqual([
      ["400.00", false],
      ["410.00", false],
      ["410.00", true],
    ]);
  });

  it("keeps at most one open span per option and valid bookkeeping", async () => {
    const { rows } = await q<{ bad: string; dup: string }>(
      `SELECT
         (SELECT count(*) FROM menu_items
           WHERE company_id = $1
             AND (last_seen_at < first_seen_at
                  OR closed_at < last_seen_at)) AS bad,
         (SELECT count(*) FROM (
            SELECT api_meal_slot_id FROM menu_items
             WHERE company_id = $1 AND closed_at IS NULL
             GROUP BY api_meal_slot_id HAVING count(*) > 1) d) AS dup`,
      [COMPANY]
    );
    expect(rows[0]).toEqual({ bad: "0", dup: "0" });
  });

  interface PriceSpan {
    total_cost: string;
    observations: number;
    open: boolean;
  }

  const priceSpans = async (): Promise<PriceSpan[]> => {
    const { rows } = await q<PriceSpan>(
      `SELECT total_cost, observations, closed_at IS NULL AS open
         FROM price_history WHERE company_id = $1
        ORDER BY first_seen_at, id`,
      [COMPANY]
    );
    return rows;
  };

  it("records identical quotes as one span and a change as a new one", async () => {
    const { recordQuote } = await import("@/scraper/scrapers/prices");
    const key = {
      cityId: CITY,
      companyId: COMPANY,
      dietCaloriesId: DC,
      orderDays: 1,
      promoCodes: [] as string[],
      tierId: 0,
    };
    await recordQuote(key, quoteValues(79.99));
    await recordQuote(key, quoteValues(79.99));
    await recordQuote(key, quoteValues(84.99));
    expect(await priceSpans()).toEqual([
      { observations: 2, open: false, total_cost: "79.99" },
      { observations: 1, open: true, total_cost: "84.99" },
    ]);

    // A promo-code variant is a separate series, not a change.
    await recordQuote({ ...key, promoCodes: ["KOD10"] }, quoteValues(76.49));
    const rows = await priceSpans();
    const open = rows.filter((r: Readonly<PriceSpan>) => r.open);
    expect(
      open.map((r: Readonly<PriceSpan>) => r.total_cost).toSorted()
    ).toEqual(["76.49", "84.99"]);
  });
  it("stores ingredient names once and keeps exclusion ids", async () => {
    const { rows } = await q<{
      name_raw: string;
      exclusion_ids: readonly number[] | null;
      names: string;
      detail: string;
    }>(
      `SELECT mi.name_raw, vi.exclusion_ids,
              (SELECT count(*) FROM ingredient_names n
                WHERE n.name_raw = mi.name_raw)::text AS names,
              (SELECT allergens_detail::text FROM meal_variants
                WHERE id = mi.variant_id) AS detail
         FROM meal_ingredients mi
         JOIN variant_ingredients vi
           ON vi.variant_id = mi.variant_id AND vi.position = mi.position
        WHERE mi.variant_id = $1 ORDER BY mi.position`,
      [variantId]
    );
    expect(
      rows.map((r: Readonly<(typeof rows)[number]>) => [
        r.name_raw,
        r.exclusion_ids,
        r.names,
      ])
    ).toEqual([
      ["Mleko", [TEST_EXCLUSION], "1"],
      ["Płatki owsiane", [], "1"],
    ]);
    expect(JSON.parse(rows[0]?.detail ?? "null")).toEqual([
      { company_name: "MLEKO", dietly_name: "Mleko", id: TEST_EXCLUSION },
    ]);
    const { rows: ex } = await q<{ name: string }>(
      "SELECT name FROM dietary_exclusions WHERE exclusion_id = $1",
      [TEST_EXCLUSION]
    );
    expect(ex[0]?.name).toBe("mleko");
  });

  it("prices one diet_calories_id separately per tier", async () => {
    const { recordQuote } = await import("@/scraper/scrapers/prices");
    const key = {
      cityId: CITY,
      companyId: COMPANY,
      dietCaloriesId: DC,
      orderDays: 2,
      promoCodes: [] as string[],
    };
    await recordQuote({ ...key, tierId: 0 }, quoteValues(61));
    await recordQuote({ ...key, tierId: 1 }, quoteValues(67));
    await recordQuote({ ...key, tierId: 0 }, quoteValues(61));
    const { rows } = await q<{
      tier_id: number;
      total_cost: string;
      observations: number;
    }>(
      `SELECT tier_id, total_cost, observations FROM price_history
        WHERE company_id = $1 AND order_days = 2 AND closed_at IS NULL
        ORDER BY tier_id`,
      [COMPANY]
    );
    expect(rows).toEqual([
      { observations: 2, tier_id: 0, total_cost: "61.00" },
      { observations: 1, tier_id: 1, total_cost: "67.00" },
    ]);
  });

  it("tracks per-city delivery fee changes as spans", async () => {
    const { recordSpan } = await import("@/scraper/spans");
    const spec = {
      key: [
        ["company_id", "text"],
        ["city_id", "bigint"],
      ],
      table: "company_city_history",
      values: [
        ["delivery_fee", "numeric(10,2)"],
        ["lowest_price_standard", "numeric(10,2)"],
        ["lowest_price_menu_config", "numeric(10,2)"],
        ["orders_enabled", "boolean"],
        ["delivery_enabled", "boolean"],
        ["delivery_times", "jsonb"],
      ],
    } as const;
    const windows = JSON.stringify([
      { from: "23:59:59", id: 1, to: "08:00:00" },
    ]);
    await recordSpan(
      spec,
      [COMPANY, CITY],
      [0, 49.9, null, true, true, windows]
    );
    await recordSpan(
      spec,
      [COMPANY, CITY],
      [0, 49.9, null, true, true, windows]
    );
    await recordSpan(
      spec,
      [COMPANY, CITY],
      [7.99, 49.9, null, true, true, windows]
    );
    const { rows } = await q<{
      delivery_fee: string;
      observations: number;
      open: boolean;
    }>(
      `SELECT delivery_fee, observations, closed_at IS NULL AS open
         FROM company_city_history WHERE company_id = $1 ORDER BY id`,
      [COMPANY]
    );
    expect(rows).toEqual([
      { delivery_fee: "0.00", observations: 2, open: false },
      { delivery_fee: "7.99", observations: 1, open: true },
    ]);
  });
});
