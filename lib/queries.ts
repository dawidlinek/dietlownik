import { query } from "./db";

export type CityRow = { city_id: number; name: string };
export type KcalRow = { calories: number };
export type DaysRow = { order_days: number };

export type CompanyRow = { company_id: string; name: string | null };

export interface DashboardRow {
  company_id: string;
  company_name: string | null;
  diet_id: number;
  diet_name: string | null;
  diet_tag: string | null;
  diet_description: string | null;
  tier_id: number | null;
  tier_name: string | null;
  diet_option_id: number | null;
  diet_option_name: string | null;
  diet_calories_id: number;
  calories: number | null;
  per_day_cost: string | null;
  per_day_cost_with_discounts: string | null;
  total_cost: string | null;
  total_cost_without_discounts: string | null;
  total_promo_code_discount: string | null;
  total_order_length_discount: string | null;
  promo_codes: string[] | null;
  captured_at: string;
  prev_per_day: string | null;
}

export interface CampaignRow {
  id: number;
  code: string | null;
  title: string | null;
  starts_at: string | null;
  ends_at: string | null;
  discount_percent: string | null;
  is_active: boolean;
  first_seen_at: string | null;
  last_seen_at: string | null;
  company_id: string | null;
}

export interface PriceHistoryPoint {
  bucket: string; // ISO date
  price: number;
  promo_codes: string[] | null;
}

// ── 1. Cities ───────────────────────────────────────────────────────────────

export async function getCities(): Promise<CityRow[]> {
  return query<CityRow>(
    `SELECT city_id::int AS city_id, name
     FROM cities
     WHERE EXISTS (SELECT 1 FROM company_cities cc WHERE cc.city_id = cities.city_id)
     ORDER BY name ASC`
  );
}

// ── 2. Kcal options for a city ──────────────────────────────────────────────

export async function getKcalOptions(cityId: number): Promise<number[]> {
  const rows = await query<KcalRow>(
    `SELECT DISTINCT dc.calories
     FROM diet_calories dc
     JOIN company_cities cc ON cc.company_id = dc.company_id
     WHERE cc.city_id = $1 AND dc.calories IS NOT NULL
     ORDER BY dc.calories ASC`,
    [cityId]
  );
  return rows.map((r) => r.calories);
}

// ── 3. Day options for a city ───────────────────────────────────────────────

export async function getDayOptions(cityId: number): Promise<number[]> {
  const rows = await query<DaysRow>(
    `SELECT DISTINCT order_days
     FROM prices
     WHERE city_id = $1
     ORDER BY order_days ASC`,
    [cityId]
  );
  return rows.map((r) => r.order_days);
}

// ── 4. Dashboard data ───────────────────────────────────────────────────────
// One row per (company, diet, tier, diet_option, diet_calories) combination
// matching the chosen kcal target, with the latest price for the chosen days.
//
// We compute the latest and second-latest captures inline with window functions
// so this works without depending on the latest_prices view.

export async function getDashboardRows(args: {
  cityId: number;
  kcal: number;
  days: number;
}): Promise<DashboardRow[]> {
  const { cityId, kcal, days } = args;
  return query<DashboardRow>(
    `
    WITH ranked AS (
      SELECT
        p.*,
        ROW_NUMBER() OVER (
          PARTITION BY p.company_id, p.city_id, p.diet_calories_id, p.order_days
          ORDER BY p.captured_at DESC, p.id DESC
        ) AS rn
      FROM prices p
      WHERE p.city_id = $1
        AND p.order_days = $2
        AND (p.promo_codes IS NULL OR cardinality(p.promo_codes) = 0)
    ),
    latest AS (
      SELECT * FROM ranked WHERE rn = 1
    ),
    prev AS (
      SELECT * FROM ranked WHERE rn = 2
    )
    SELECT
      l.company_id,
      co.name                            AS company_name,
      dc.diet_id,
      d.name                             AS diet_name,
      d.diet_tag                         AS diet_tag,
      d.description                      AS diet_description,
      dc.tier_id,
      t.name                             AS tier_name,
      dc.diet_option_id,
      do2.name                           AS diet_option_name,
      dc.diet_calories_id,
      dc.calories,
      l.per_day_cost::text               AS per_day_cost,
      l.per_day_cost_with_discounts::text AS per_day_cost_with_discounts,
      l.total_cost::text                 AS total_cost,
      l.total_cost_without_discounts::text AS total_cost_without_discounts,
      l.total_promo_code_discount::text  AS total_promo_code_discount,
      l.total_order_length_discount::text AS total_order_length_discount,
      l.promo_codes,
      l.captured_at,
      prev.per_day_cost_with_discounts::text AS prev_per_day
    FROM latest l
    JOIN diet_calories dc ON dc.diet_calories_id = l.diet_calories_id
    JOIN companies co     ON co.company_id = l.company_id
    JOIN diets d          ON d.diet_id = dc.diet_id AND d.company_id = dc.company_id
    LEFT JOIN tiers t
      ON t.tier_id = dc.tier_id
     AND t.diet_id = dc.diet_id
     AND t.company_id = dc.company_id
    LEFT JOIN diet_options do2
      ON do2.diet_option_id = dc.diet_option_id
     AND do2.tier_id = dc.tier_id
     AND do2.diet_id = dc.diet_id
     AND do2.company_id = dc.company_id
    LEFT JOIN prev
      ON prev.company_id = l.company_id
     AND prev.city_id = l.city_id
     AND prev.diet_calories_id = l.diet_calories_id
     AND prev.order_days = l.order_days
    WHERE dc.calories = $3
    ORDER BY
      CASE WHEN d.diet_tag = 'STANDARD' THEN 0 ELSE 1 END,
      d.diet_tag NULLS LAST,
      co.name NULLS LAST,
      d.name NULLS LAST,
      t.name NULLS LAST
    `,
    [cityId, days, kcal]
  );
}

// ── 5. Companies operating in a city (for the summary line) ─────────────────

export async function getCompaniesInCity(cityId: number): Promise<CompanyRow[]> {
  return query<CompanyRow>(
    `SELECT c.company_id, c.name
     FROM companies c
     JOIN company_cities cc ON cc.company_id = c.company_id
     WHERE cc.city_id = $1
     ORDER BY c.company_id ASC`,
    [cityId]
  );
}

// ── 6. Active campaigns ─────────────────────────────────────────────────────

export async function getActiveCampaigns(): Promise<CampaignRow[]> {
  // active_promotions (v4) supersedes active_campaigns (v2). Try v4 first,
  // fall back to v2, fall back to a direct campaigns scan.
  try {
    return await query<CampaignRow>(
      `SELECT id, code, title,
              starts_at::text, ends_at::text,
              discount_percent::text, is_active,
              first_seen_at::text, last_seen_at::text,
              company_id
       FROM active_promotions
       ORDER BY company_id NULLS FIRST, ends_at ASC NULLS LAST`
    );
  } catch {
    try {
      return await query<CampaignRow>(
        `SELECT id, code, title,
                starts_at::text, ends_at::text,
                discount_percent::text, is_active,
                first_seen_at::text, last_seen_at::text,
                company_id
         FROM active_campaigns
         ORDER BY company_id NULLS FIRST, ends_at ASC NULLS LAST`
      );
    } catch {
      return query<CampaignRow>(
        `SELECT id, code, title,
                starts_at::text, ends_at::text,
                discount_percent::text, is_active,
                NULL::text AS first_seen_at, NULL::text AS last_seen_at,
                company_id
         FROM campaigns
         WHERE is_active = TRUE
           AND (ends_at IS NULL OR ends_at >= CURRENT_DATE)
         ORDER BY company_id NULLS FIRST, ends_at ASC NULLS LAST`
      );
    }
  }
}

// ── 7. Price history for one (company, diet_calories, city, days) combo ────

export async function getPriceHistory(args: {
  companyId: string;
  dietCaloriesId: number;
  cityId: number;
  days: number;
}): Promise<PriceHistoryPoint[]> {
  const { companyId, dietCaloriesId, cityId, days } = args;
  return query<PriceHistoryPoint>(
    `
    SELECT
      to_char(day, 'YYYY-MM-DD') AS bucket,
      price::float                AS price,
      promo_codes
    FROM (
      SELECT DISTINCT ON (date_trunc('day', captured_at))
        date_trunc('day', captured_at) AS day,
        per_day_cost_with_discounts    AS price,
        promo_codes
      FROM prices
      WHERE company_id = $1
        AND diet_calories_id = $2
        AND city_id = $3
        AND order_days = $4
      ORDER BY date_trunc('day', captured_at), captured_at DESC, id DESC
    ) t
    ORDER BY day ASC
    `,
    [companyId, dietCaloriesId, cityId, days]
  );
}
