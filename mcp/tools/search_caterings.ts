import { z } from "zod";
import { q } from "@/scraper/db";

export const searchCateringsInputSchema = z.object({
  city_id: z.number().int().positive(),
  diet_tag: z.string().min(1).optional(),
  max_price_per_day: z.number().positive().optional(),
  min_score: z.number().min(0).max(100).optional(),
  with_promo_only: z.boolean().optional(),
});

export type SearchCateringsInput = z.infer<typeof searchCateringsInputSchema>;

export const searchCateringsOutputSchema = z.object({
  total: z.number(),
  caterings: z.array(z.unknown()),
});

interface SearchRow {
  company_id: string;
  company_name: string | null;
  avg_score: string | number | null;
  price_category: string | null;
  awarded: boolean | null;
  diet_name: string | null;
  diet_tag: string | null;
  is_menu_configuration: boolean | null;
  tier_id: number | null;
  tier_name: string | null;
  tier_diet_option_id: string | null;
  diet_calories_id: number;
  calories: number | null;
  price_per_day: string | number | null;
  order_days: number | null;
  promo_code: string | null;
  promo_discount: string | number | null;
  promo_deadline: string | null;
}

const SEARCH_SQL = `
SELECT
  co.company_id,
  co.name AS company_name,
  co.avg_score,
  co.price_category,
  co.awarded,
  d.name AS diet_name,
  d.diet_tag,
  d.is_menu_configuration,
  t.tier_id,
  t.name AS tier_name,
  do2.tier_diet_option_id,
  dc.diet_calories_id,
  dc.calories,
  lp.per_day_cost_with_discounts AS price_per_day,
  lp.order_days,
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
  SELECT per_day_cost_with_discounts, order_days
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
ORDER BY lp.per_day_cost_with_discounts ASC NULLS LAST
LIMIT 50
`;

function toNumber(value: string | number | null): number | null {
  if (value == null) return null;
  if (typeof value === "number") return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function searchCateringsTool(input: SearchCateringsInput) {
  const result = await q<SearchRow>(SEARCH_SQL, [input.city_id]);

  let rows = result.rows.map((row) => ({
    ...row,
    avg_score_num: toNumber(row.avg_score),
    price_per_day_num: toNumber(row.price_per_day),
    promo_discount_num: toNumber(row.promo_discount),
  }));

  if (input.diet_tag) {
    rows = rows.filter((row) => row.diet_tag === input.diet_tag);
  }

  const maxPricePerDay = input.max_price_per_day;
  if (typeof maxPricePerDay === "number") {
    rows = rows.filter(
      (row) => row.price_per_day_num !== null && row.price_per_day_num <= maxPricePerDay
    );
  }

  const minScore = input.min_score;
  if (typeof minScore === "number") {
    rows = rows.filter(
      (row) => row.avg_score_num !== null && row.avg_score_num >= minScore
    );
  }

  if (input.with_promo_only) {
    rows = rows.filter((row) => Boolean(row.promo_code));
  }

  rows.sort((a, b) => {
    if (a.price_per_day_num == null && b.price_per_day_num == null) return 0;
    if (a.price_per_day_num == null) return 1;
    if (b.price_per_day_num == null) return -1;
    return a.price_per_day_num - b.price_per_day_num;
  });

  const caterings = rows.slice(0, 50);
  return { total: caterings.length, caterings };
}
