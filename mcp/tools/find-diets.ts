import { z } from "zod";

import { encodeOfferId } from "@/mcp/offer";
import { defineTool } from "@/mcp/tool";
import { q } from "@/scraper/db";

const inputSchema = z.object({
  city: z
    .string()
    .min(1)
    .describe(
      "City name in Polish (e.g. 'Wrocław', 'Warszawa', 'Kraków'). Resolved server-side; agent never passes a city id."
    ),
  diet_tag: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Diet category tag (e.g. 'STANDARD', 'KETO', 'VEGAN'). Omit to include all."
    ),
  kcal_max: z.number().int().positive().optional(),
  kcal_min: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(50).default(20),
  max_price_per_day: z.number().positive().optional().describe("PLN per day."),
  min_score: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe("Minimum average review score (0-100)."),
  sort_by: z.enum(["price", "score"]).default("price"),
  with_promo_only: z
    .boolean()
    .optional()
    .describe("Restrict to offers with an active promo code."),
});

const outputSchema = z.object({
  city: z.object({ id: z.number(), name: z.string() }),
  offers: z.array(
    z.object({
      avg_score: z.number().nullable(),
      awarded: z.boolean(),
      calories: z.number().nullable(),
      company: z.object({ id: z.string(), name: z.string().nullable() }),
      diet: z.object({
        name: z.string().nullable(),
        tag: z.string().nullable(),
      }),
      is_configurable: z
        .boolean()
        .describe(
          "True if menu-configuration diet (allows per-day meal choice in get_menu)."
        ),
      offer_id: z
        .string()
        .describe(
          "Opaque token. Pass to get_menu / quote_order / place_order. Do not parse or hand-construct."
        ),
      price_per_day: z
        .number()
        .nullable()
        .describe("PLN. Computed for a 5-day order."),
      promo: z
        .object({
          code: z.string(),
          deadline: z.string().nullable(),
          discount_percent: z.number().nullable(),
        })
        .nullable(),
      tier: z.object({ name: z.string().nullable() }).nullable(),
    })
  ),
  total: z.number(),
});

interface FindRow {
  readonly awarded: boolean | null;
  readonly avg_score: string | number | null;
  readonly calories: number | null;
  readonly company_id: string;
  readonly company_name: string | null;
  readonly diet_calories_id: number;
  readonly diet_name: string | null;
  readonly diet_tag: string | null;
  readonly is_menu_configuration: boolean | null;
  readonly price_per_day: string | number | null;
  readonly promo_code: string | null;
  readonly promo_deadline: string | null;
  readonly promo_discount: string | number | null;
  readonly tier_diet_option_id: string | null;
  readonly tier_name: string | null;
}

interface EnrichedRow extends FindRow {
  readonly avg_score_num: number | null;
  readonly price_per_day_num: number | null;
  readonly promo_discount_num: number | null;
}

// Postgres-side filters: city, diet_tag, kcal range, price cap, score floor,
// promo presence. Sort + limit happen in-process so we can sort by either
// price or score with consistent NULLS-LAST semantics.
//
// $1 = city_id, $2 = diet_tag (nullable), $3 = kcal_min (nullable),
// $4 = kcal_max (nullable), $5 = max_price_per_day (nullable),
// $6 = min_score (nullable), $7 = with_promo_only (boolean).
const FIND_SQL = `
SELECT
  co.company_id,
  co.name AS company_name,
  co.avg_score,
  co.awarded,
  d.name AS diet_name,
  d.diet_tag,
  d.is_menu_configuration,
  t.name AS tier_name,
  do2.tier_diet_option_id,
  dc.diet_calories_id,
  dc.calories,
  lp.per_day_cost_with_discounts AS price_per_day,
  cam.code AS promo_code,
  cam.discount_percent AS promo_discount,
  cam.ends_at AS promo_deadline
FROM companies co
JOIN diets d
  ON d.company_id = co.company_id
 AND d.valid_to IS NULL
JOIN tiers t
  ON t.company_id = co.company_id
 AND t.diet_id = d.diet_id
 AND t.valid_to IS NULL
JOIN diet_options do2
  ON do2.company_id = co.company_id
 AND do2.diet_id = d.diet_id
 AND do2.tier_id = t.tier_id
 AND do2.valid_to IS NULL
JOIN diet_calories dc
  ON dc.company_id = co.company_id
 AND dc.diet_id = d.diet_id
 AND dc.tier_id = t.tier_id
 AND dc.diet_option_id = do2.diet_option_id
 AND dc.valid_to IS NULL
JOIN company_cities cc
  ON cc.company_id = co.company_id
 AND cc.city_id = $1
LEFT JOIN LATERAL (
  SELECT per_day_cost_with_discounts
  FROM prices
  WHERE diet_calories_id = dc.diet_calories_id
    AND city_id = $1
    AND order_days = 5
  ORDER BY captured_at DESC
  LIMIT 1
) lp ON TRUE
LEFT JOIN LATERAL (
  SELECT code, discount_percent, ends_at
  FROM campaigns
  WHERE is_active = TRUE
    AND (ends_at IS NULL OR ends_at >= CURRENT_DATE)
  ORDER BY ends_at ASC
  LIMIT 1
) cam ON TRUE
WHERE co.orders_enabled = TRUE
  AND ($2::text IS NULL OR d.diet_tag = $2)
  AND ($3::int IS NULL OR dc.calories >= $3)
  AND ($4::int IS NULL OR dc.calories <= $4)
  AND ($5::numeric IS NULL OR lp.per_day_cost_with_discounts <= $5)
  AND ($6::numeric IS NULL OR co.avg_score >= $6)
  AND ($7::boolean = FALSE OR cam.code IS NOT NULL)
`;

const toNumber = (value: string | number | null): number | null => {
  if (value === null) {
    return null;
  }
  if (typeof value === "number") {
    return value;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const compareByPrice = (
  a: Readonly<EnrichedRow>,
  b: Readonly<EnrichedRow>
): number => {
  // ASC NULLS LAST.
  if (a.price_per_day_num === null && b.price_per_day_num === null) {
    return 0;
  }
  if (a.price_per_day_num === null) {
    return 1;
  }
  if (b.price_per_day_num === null) {
    return -1;
  }
  return a.price_per_day_num - b.price_per_day_num;
};

const compareByScore = (
  a: Readonly<EnrichedRow>,
  b: Readonly<EnrichedRow>
): number => {
  // DESC NULLS LAST.
  if (a.avg_score_num === null && b.avg_score_num === null) {
    return 0;
  }
  if (a.avg_score_num === null) {
    return 1;
  }
  if (b.avg_score_num === null) {
    return -1;
  }
  return b.avg_score_num - a.avg_score_num;
};

export const find_diets = defineTool({
  annotations: { openWorldHint: false, readOnlyHint: true },
  description:
    "Search the local scraper Postgres for catering diet offers in a city, " +
    "filtered by diet tag, kcal range, max per-day price, min review " +
    "score, or active promo. Use this as the entry point before " +
    "`get_menu` / `quote_order` / `place_order`. Returns opaque " +
    "`offer_id` tokens those tools accept — never parse or invent them.",
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ctx (ToolContext) embeds the DietlyClient class instance; tool only invokes its public methods
  execute: async (input, ctx) => {
    // CityResolveError extends Error; the dispatcher's toErrorResult will
    // surface .message verbatim as a structured tool error.
    const resolved = await ctx.client.cities.resolve(input.city);

    const dietTag =
      input.diet_tag !== undefined && input.diet_tag !== ""
        ? input.diet_tag
        : null;
    const kcalMin = input.kcal_min ?? null;
    const kcalMax = input.kcal_max ?? null;
    const maxPrice = input.max_price_per_day ?? null;
    const minScore = input.min_score ?? null;
    const withPromoOnly = input.with_promo_only === true;

    const result = await q<FindRow>(FIND_SQL, [
      resolved.id,
      dietTag,
      kcalMin,
      kcalMax,
      maxPrice,
      minScore,
      withPromoOnly,
    ]);

    const enriched: readonly EnrichedRow[] = result.rows.map(
      (row: Readonly<FindRow>): EnrichedRow => ({
        ...row,
        avg_score_num: toNumber(row.avg_score),
        price_per_day_num: toNumber(row.price_per_day),
        promo_discount_num: toNumber(row.promo_discount),
      })
    );

    const sorted = enriched.toSorted(
      input.sort_by === "score" ? compareByScore : compareByPrice
    );

    const limited = sorted.slice(0, input.limit);

    const offers = limited.map((row: Readonly<EnrichedRow>) => {
      const isMenuConfig = row.is_menu_configuration === true;
      const tierOptId =
        row.tier_diet_option_id !== null && row.tier_diet_option_id !== ""
          ? row.tier_diet_option_id
          : undefined;
      const offer_id = encodeOfferId({
        company_id: row.company_id,
        diet_calories_id: row.diet_calories_id,
        is_menu_configuration: isMenuConfig,
        ...(isMenuConfig && tierOptId !== undefined
          ? { tier_diet_option_id: tierOptId }
          : {}),
      });
      const promo =
        row.promo_code !== null && row.promo_code !== ""
          ? {
              code: row.promo_code,
              deadline: row.promo_deadline,
              discount_percent: row.promo_discount_num,
            }
          : null;
      return {
        avg_score: row.avg_score_num,
        awarded: row.awarded === true,
        calories: row.calories,
        company: { id: row.company_id, name: row.company_name },
        diet: { name: row.diet_name, tag: row.diet_tag },
        is_configurable: isMenuConfig,
        offer_id,
        price_per_day: row.price_per_day_num,
        promo,
        tier: row.tier_name === null ? null : { name: row.tier_name },
      };
    });

    return {
      city: { id: resolved.id, name: resolved.name },
      offers,
      total: offers.length,
    };
  },
  inputSchema,
  name: "find_diets",
  outputSchema,
});
