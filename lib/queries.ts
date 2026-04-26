import { query } from "./db";

export type CityRow = { city_id: number; name: string };
export type KcalRow = { calories: number };
export type DaysRow = { order_days: number };

export type CompanyRow = { company_id: string; name: string | null };

/** One leaf row — a single (company, diet, tier, option, kcal) price observation. */
export interface LeafRow {
  company_id: string;
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

/** A catering "tile" — one company, with its cheapest leaf surfaced. */
export interface CateringTile {
  company_id: string;
  company_name: string | null;
  awarded: boolean | null;
  feedback_value: string | null;
  feedback_number: number | null;
  /** The single cheapest leaf for this company in the kcal range. */
  cheapest: LeafRow;
  /** All leaves for this company in the kcal range, sorted asc by price. */
  leaves: LeafRow[];
}

export interface CateringPage {
  tiles: CateringTile[];
  total: number;          // total number of companies that have at least one leaf in range
  page: number;           // 1-indexed
  pageSize: number;
  rangeMin: number | null;  // cheapest per-day price across ALL pages, for the header summary
  rangeMax: number | null;  // costliest per-day price across ALL pages
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

// ── 2. Kcal range bounds for a city ─────────────────────────────────────────

export interface KcalBounds {
  min: number;
  max: number;
  /** Distinct kcal values with enough data to be useful as preset chips. */
  presets: number[];
}

const PRESET_CANDIDATES = [1200, 1500, 1800, 2000, 2500];
const KCAL_HARD_CAP = 4000; // Filter junk like 6000/10000 outliers from filter UI.

export async function getKcalBounds(cityId: number): Promise<KcalBounds> {
  const [bounds] = await query<{ min: number | null; max: number | null }>(
    `SELECT
        MIN(dc.calories)::int AS min,
        MAX(dc.calories)::int AS max
     FROM diet_calories dc
     JOIN company_cities cc ON cc.company_id = dc.company_id
     WHERE cc.city_id = $1
       AND dc.calories IS NOT NULL
       AND dc.calories <= $2
       AND dc.valid_to IS NULL`,
    [cityId, KCAL_HARD_CAP]
  );

  // Which presets actually have data in this city?
  const hits = await query<{ calories: number }>(
    `SELECT DISTINCT dc.calories
     FROM diet_calories dc
     JOIN company_cities cc ON cc.company_id = dc.company_id
     WHERE cc.city_id = $1
       AND dc.calories = ANY($2::int[])
       AND dc.valid_to IS NULL`,
    [cityId, PRESET_CANDIDATES]
  );
  const present = new Set(hits.map((h) => h.calories));
  const presets = PRESET_CANDIDATES.filter((p) => present.has(p));

  return {
    min: bounds?.min ?? 1000,
    max: bounds?.max ?? 3000,
    presets: presets.length ? presets : PRESET_CANDIDATES,
  };
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

// ── 4. The catering page (flat tiles, paginated) ────────────────────────────
//
// One row per company in the city. Each row carries:
//   - the cheapest leaf (for ranking + the collapsed display)
//   - every leaf in range (for the drill-down table; sorted asc)
//   - rating / awarded info from the companies table
// `total` is the total number of companies in range (for pagination).

const PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;

export async function getCateringPage(args: {
  cityId: number;
  kcalMin: number;
  kcalMax: number;
  days: number;
  page: number;          // 1-indexed
  pageSize?: number;
}): Promise<CateringPage> {
  const { cityId, kcalMin, kcalMax, days } = args;
  const page = Math.max(1, args.page);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, args.pageSize ?? PAGE_SIZE));
  const offset = (page - 1) * pageSize;

  // We DISTINCT ON (company, dc_id, tier|null, option|null, days) to capture
  // the latest capture per real combo (the same dc_id can appear under
  // multiple tiers — verified live: different prices). Then we filter by
  // calories range, group per company, sort ascending by cheapest.
  type PageRow = {
    company_id: string;
    company_name: string | null;
    awarded: boolean | null;
    feedback_value: string | null;
    feedback_number: number | null;
    cheapest: string;       // numeric cast — comparable for ordering
    leaves: string;          // jsonb agg
    total_companies: number;
    overall_min: string | null;
    overall_max: string | null;
  };

  const rows = await query<PageRow>(
    `
    WITH ranked AS (
      SELECT
        p.*,
        ROW_NUMBER() OVER (
          PARTITION BY p.company_id, p.diet_calories_id,
                       COALESCE(p.tier_diet_option_id, ''), p.order_days
          ORDER BY p.captured_at DESC, p.id DESC
        ) AS rn
      FROM prices p
      WHERE p.city_id    = $1
        AND p.order_days = $2
        AND (p.promo_codes IS NULL OR cardinality(p.promo_codes) = 0)
    ),
    leaves_in_range AS (
      SELECT
        r.company_id,
        dc.diet_id,
        d.name                                  AS diet_name,
        d.diet_tag,
        d.description                           AS diet_description,
        dc.tier_id,
        t.name                                  AS tier_name,
        dc.diet_option_id,
        do2.name                                AS diet_option_name,
        dc.diet_calories_id,
        dc.calories,
        r.per_day_cost::text                    AS per_day_cost,
        r.per_day_cost_with_discounts::text     AS per_day_cost_with_discounts,
        r.total_cost::text                      AS total_cost,
        r.total_cost_without_discounts::text    AS total_cost_without_discounts,
        r.total_promo_code_discount::text       AS total_promo_code_discount,
        r.total_order_length_discount::text     AS total_order_length_discount,
        r.promo_codes,
        r.captured_at::text                     AS captured_at,
        r.per_day_cost_with_discounts::numeric  AS per_day_num,
        r.tier_diet_option_id
      FROM ranked r
      -- Use the composite tier_diet_option_id to disambiguate when the same
      -- dietCaloriesId lives under multiple tiers. For ready diets both sides
      -- are NULL — match via COALESCE.
      JOIN diet_calories dc
        ON dc.diet_calories_id = r.diet_calories_id
       AND dc.company_id        = r.company_id
       AND (
         (dc.tier_id IS NULL AND dc.diet_option_id IS NULL AND r.tier_diet_option_id IS NULL)
         OR (
           dc.tier_id IS NOT NULL AND dc.diet_option_id IS NOT NULL
           AND r.tier_diet_option_id = dc.tier_id || '-' || dc.diet_option_id
         )
       )
      JOIN diets d
        ON d.diet_id = dc.diet_id AND d.company_id = dc.company_id
      LEFT JOIN tiers t
        ON t.tier_id = dc.tier_id AND t.diet_id = dc.diet_id AND t.company_id = dc.company_id
      LEFT JOIN diet_options do2
        ON do2.diet_option_id = dc.diet_option_id
       AND do2.tier_id = dc.tier_id
       AND do2.diet_id = dc.diet_id
       AND do2.company_id = dc.company_id
      WHERE r.rn = 1
        AND dc.calories BETWEEN $3 AND $4
        AND dc.valid_to IS NULL
        AND d.valid_to  IS NULL
    ),
    -- Previous (rn = 2) capture, for the price delta arrow.
    prev AS (
      SELECT
        company_id, diet_calories_id,
        COALESCE(tier_diet_option_id, '') AS tdo_key,
        order_days,
        per_day_cost_with_discounts::text AS prev_per_day
      FROM ranked
      WHERE rn = 2
    ),
    enriched AS (
      SELECT
        l.*,
        prev.prev_per_day
      FROM leaves_in_range l
      LEFT JOIN prev
        ON prev.company_id       = l.company_id
       AND prev.diet_calories_id = l.diet_calories_id
       AND prev.tdo_key          = COALESCE(l.tier_diet_option_id, '')
    ),
    grouped AS (
      SELECT
        e.company_id,
        MIN(e.per_day_num) AS cheapest_num,
        json_agg(
          json_build_object(
            'company_id',                    e.company_id,
            'diet_id',                       e.diet_id,
            'diet_name',                     e.diet_name,
            'diet_tag',                      e.diet_tag,
            'diet_description',              e.diet_description,
            'tier_id',                       e.tier_id,
            'tier_name',                     e.tier_name,
            'diet_option_id',                e.diet_option_id,
            'diet_option_name',              e.diet_option_name,
            'diet_calories_id',              e.diet_calories_id,
            'calories',                      e.calories,
            'per_day_cost',                  e.per_day_cost,
            'per_day_cost_with_discounts',   e.per_day_cost_with_discounts,
            'total_cost',                    e.total_cost,
            'total_cost_without_discounts',  e.total_cost_without_discounts,
            'total_promo_code_discount',     e.total_promo_code_discount,
            'total_order_length_discount',   e.total_order_length_discount,
            'promo_codes',                   e.promo_codes,
            'captured_at',                   e.captured_at,
            'prev_per_day',                  e.prev_per_day
          )
          ORDER BY e.per_day_num ASC, e.calories ASC
        ) AS leaves
      FROM enriched e
      GROUP BY e.company_id
    )
    SELECT
      g.company_id,
      co.name                          AS company_name,
      co.awarded                       AS awarded,
      co.feedback_value::text          AS feedback_value,
      co.feedback_number,
      g.cheapest_num::text             AS cheapest,
      g.leaves::text                   AS leaves,
      COUNT(*) OVER ()::int            AS total_companies,
      MIN(g.cheapest_num) OVER ()::text AS overall_min,
      MAX(g.cheapest_num) OVER ()::text AS overall_max
    FROM grouped g
    JOIN companies co ON co.company_id = g.company_id
    ORDER BY g.cheapest_num ASC, g.company_id ASC
    LIMIT $5 OFFSET $6
    `,
    [cityId, days, kcalMin, kcalMax, pageSize, offset]
  );

  const tiles: CateringTile[] = rows.map((r) => {
    const leaves = JSON.parse(r.leaves) as LeafRow[];
    return {
      company_id: r.company_id,
      company_name: r.company_name,
      awarded: r.awarded,
      feedback_value: r.feedback_value,
      feedback_number: r.feedback_number,
      cheapest: leaves[0],
      leaves,
    };
  });

  const total = rows[0]?.total_companies ?? 0;
  const overallMin = rows[0]?.overall_min ?? null;
  const overallMax = rows[0]?.overall_max ?? null;

  return {
    tiles,
    total,
    page,
    pageSize,
    rangeMin: overallMin ? parseFloat(overallMin) : null,
    rangeMax: overallMax ? parseFloat(overallMax) : null,
  };
}

// ── 5. Active campaigns ─────────────────────────────────────────────────────

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

// ── 6. Price history for one (company, diet_calories, city, days) combo ────

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
