import { z } from "zod";

import { encodeOfferId } from "@/mcp/offer";
import { priceSchema, round } from "@/mcp/present";
import { defineTool } from "@/mcp/tool";
import { q } from "@/scraper/db";

// Catalog search, independent of any day's menu: "which keto diets under
// 60 zł are there?". `plan` can't filter by diet type; this can. Prices are
// the same current quotes the ranking uses — list price, and the cheapest
// promo-applied quote with the code it took.

const inputSchema = z.object({
  city: z.string().min(1).default("Wrocław"),
  diet_tag: z
    .string()
    .min(1)
    .optional()
    .describe(
      "dietly's diet type, case-insensitive: STANDARD, SPORT, LOW IG, WEIGHT LOSS, KETO, VEGETARIAN, VEGAN, VEGE AND FISH, GLUTEN LACTOSE FREE, LOW CARB, DASH, … (get_context lists them)."
    ),
  include_shared_packages: z
    .boolean()
    .default(false)
    .describe("Include 'dla dwojga' / 'duo' packages (priced for two)."),
  kcal_max: z.number().int().positive().optional(),
  kcal_min: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(50).default(20),
  max_price_per_day: z
    .number()
    .positive()
    .optional()
    .describe("PLN per day, promo applied."),
  min_rating: z
    .number()
    .min(0)
    .max(5)
    .optional()
    .describe("Catering rating 0–5; caterings with no reviews are dropped."),
  sort_by: z.enum(["price", "rating"]).default("price"),
  with_promo_only: z.boolean().default(false),
});

const outputSchema = z.object({
  city: z.string(),
  offers: z.array(
    z.object({
      catering: z.object({
        id: z.string(),
        name: z.string(),
        rating: z.number().nullable().describe("0–5."),
        reviews: z.number(),
      }),
      diet: z.string(),
      diet_tag: z.string().nullable(),
      is_configurable: z.boolean(),
      kcal: z.number().nullable(),
      offer_id: z.string(),
      price: priceSchema,
      tier: z.string().nullable(),
      variant: z.string().nullable(),
    })
  ),
  total: z.number(),
});

interface FindRow {
  readonly company_id: string;
  readonly company_name: string | null;
  readonly avg_score: string | null;
  readonly reviews: number | null;
  readonly diet_name: string | null;
  readonly diet_tag: string | null;
  readonly is_menu_configuration: boolean | null;
  readonly tier_name: string | null;
  readonly option_name: string | null;
  readonly tier_diet_option_id: string | null;
  readonly diet_calories_id: number;
  readonly calories: number | null;
  readonly list_price: string | null;
  readonly price: string | null;
  readonly promo_code: string | null;
  readonly promo_discount: string | null;
  readonly promo_ends: string | null;
}

// $1 city_id, $2 diet_tag, $3 kcal_min, $4 kcal_max, $5 max price,
// $6 min rating (0–5), $7 promo only, $8 shared-package tier regex (NULL =
// keep them). Sort and limit happen in-process.
//
// One row per leaf (company, diet_calories_id, tier, option). Price is the
// cheapest open quote seen in the last 30 days whose code is still running —
// the same rule as the ranking's `priced` CTE — and list is the no-code quote.
// `companies.avg_score` is 0–100 and reads 0 or 100 for caterings with no
// reviews, so it only counts when `feedback_number > 0`.
const FIND_SQL = `
WITH leaves AS (
  SELECT
    co.company_id, co.name AS company_name,
    CASE WHEN co.feedback_number > 0 THEN co.avg_score / 20 END AS avg_score,
    COALESCE(co.feedback_number, 0) AS reviews,
    d.name AS diet_name, d.diet_tag, d.is_menu_configuration,
    t.name AS tier_name, do2.name AS option_name, do2.tier_diet_option_id,
    dc.diet_calories_id, dc.calories
  FROM companies co
  JOIN company_cities cc ON cc.company_id = co.company_id AND cc.city_id = $1
                        AND cc.is_active
  JOIN diets d ON d.company_id = co.company_id AND d.is_active
  JOIN tiers t ON t.company_id = co.company_id AND t.diet_id = d.diet_id AND t.is_active
  JOIN diet_options do2 ON do2.company_id = co.company_id AND do2.diet_id = d.diet_id
                       AND do2.tier_id = t.tier_id AND do2.is_active
  JOIN diet_calories dc ON dc.company_id = co.company_id AND dc.diet_id = d.diet_id
                       AND dc.tier_id = t.tier_id AND dc.diet_option_id = do2.diet_option_id
                       AND dc.is_active
  WHERE co.orders_enabled
    AND ($2::text IS NULL OR upper(d.diet_tag) = upper($2))
    AND ($3::int IS NULL OR dc.calories >= $3)
    AND ($4::int IS NULL OR dc.calories <= $4)
    AND ($8::text IS NULL OR t.name !~* $8::text)
),
priced AS (
  SELECT l.*, lp.list_price, bp.price, bp.promo_code
  FROM leaves l
  JOIN LATERAL (
    SELECT min(ph.total_cost / NULLIF(ph.order_days, 0)) AS list_price
    FROM city_quotes($1) ph
    WHERE ph.company_id = l.company_id AND ph.diet_calories_id = l.diet_calories_id
      AND ph.closed_at IS NULL AND ph.promo_codes = '{}'
      AND ph.last_seen_at > now() - interval '30 days'
  ) lp ON TRUE
  JOIN LATERAL (
    SELECT ph.total_cost / NULLIF(ph.order_days, 0) AS price,
           ph.promo_codes[1] AS promo_code
    FROM city_quotes($1) ph
    WHERE ph.company_id = l.company_id AND ph.diet_calories_id = l.diet_calories_id
      AND ph.closed_at IS NULL AND ph.total_cost IS NOT NULL
      AND ph.last_seen_at > now() - interval '30 days'
      AND (ph.promo_codes = '{}' OR EXISTS (
            SELECT 1 FROM campaigns c
            WHERE c.company_id = ph.company_id AND c.code = ANY (ph.promo_codes)
              AND c.is_active
              AND (c.starts_at IS NULL OR c.starts_at <= CURRENT_DATE)
              AND (c.ends_at   IS NULL OR c.ends_at   >= CURRENT_DATE)))
    ORDER BY (ph.order_days = 1) DESC, ph.total_cost / NULLIF(ph.order_days, 0) ASC
    LIMIT 1
  ) bp ON TRUE
)
SELECT DISTINCT ON (p.company_id, p.diet_calories_id, p.tier_diet_option_id)
  p.*,
  cam.discount_percent AS promo_discount,
  cam.ends_at::text    AS promo_ends
FROM priced p
LEFT JOIN campaigns cam
  ON cam.code = p.promo_code
 AND (cam.company_id = p.company_id OR cam.company_id IS NULL)
WHERE ($5::numeric IS NULL OR p.price <= $5)
  AND ($6::numeric IS NULL OR p.avg_score >= $6)
  AND ($7::boolean = FALSE OR p.promo_code IS NOT NULL)
ORDER BY p.company_id, p.diet_calories_id, p.tier_diet_option_id,
         (cam.company_id IS NOT NULL) DESC
`;

// Postgres ARE: "dwoj" anywhere, or "duo" / "duet" / "duecie" as a word — same rule as the
// ranking's SHARED_PACKAGE_TIER_RE.
const SHARED_PACKAGE_RE = String.raw`dwoj|\mdu(o|et|ecie)\M`;

const toNum = (v: string | number | null): number | null => {
  if (v === null) {
    return null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export const find_diets = defineTool({
  annotations: { openWorldHint: false, readOnlyHint: true },
  description:
    "Browse the diet catalog in a city — by diet type (KETO, VEGAN, …), " +
    "kcal, price and catering rating — without looking at any day's menu. " +
    "Use it for 'what vegan diets are there under 70 zł'; use `plan` to " +
    "choose by what is actually on the menu. Returns the same `offer_id`s.",
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ctx (ToolContext) embeds the DietlyClient class instance; tool only invokes its public methods
  execute: async (input, ctx) => {
    const city = await ctx.client.cities.resolve(input.city);
    const res = await q<FindRow>(FIND_SQL, [
      city.id,
      input.diet_tag ?? null,
      input.kcal_min ?? null,
      input.kcal_max ?? null,
      input.max_price_per_day ?? null,
      input.min_rating ?? null,
      input.with_promo_only,
      input.include_shared_packages ? null : SHARED_PACKAGE_RE,
    ]);
    const rows = res.rows.toSorted((a, b) => {
      if (input.sort_by === "rating") {
        const diff = (toNum(b.avg_score) ?? -1) - (toNum(a.avg_score) ?? -1);
        if (diff !== 0) {
          return diff;
        }
      }
      return (toNum(a.price) ?? Infinity) - (toNum(b.price) ?? Infinity);
    });
    const offers = rows.slice(0, input.limit).map((r) => {
      const isConfig = r.is_menu_configuration === true;
      const price = toNum(r.price) ?? 0;
      const list = toNum(r.list_price);
      const rating = toNum(r.avg_score);
      return {
        catering: {
          id: r.company_id,
          name: r.company_name ?? r.company_id,
          rating: rating === null ? null : round(rating, 2),
          reviews: r.reviews ?? 0,
        },
        diet: r.diet_name ?? "",
        diet_tag: r.diet_tag,
        is_configurable: isConfig,
        kcal: r.calories,
        offer_id: encodeOfferId({
          company_id: r.company_id,
          diet_calories_id: r.diet_calories_id,
          is_menu_configuration: isConfig,
          ...(isConfig && r.tier_diet_option_id !== null
            ? { tier_diet_option_id: r.tier_diet_option_id }
            : {}),
        }),
        price: {
          list: list === null ? null : round(list),
          per_day: round(price),
          promo:
            r.promo_code === null
              ? null
              : {
                  code: r.promo_code,
                  discount_percent:
                    toNum(r.promo_discount) ??
                    (list === null || list === 0
                      ? 0
                      : round((1 - price / list) * 100, 0)),
                  ends_at: r.promo_ends,
                },
        },
        tier: r.tier_name,
        variant: r.option_name,
      };
    });
    return { city: city.name, offers, total: rows.length };
  },
  inputSchema,
  name: "find_diets",
  outputSchema,
});
