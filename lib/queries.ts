import { encodeOfferId } from "../mcp/offer";
import { query } from "./db";
import { toPgVector } from "./embeddings";
import { routePreferences } from "./preference-router";
import type { MacroField, RoutedIntents } from "./preference-router";

export interface CityRow {
  readonly city_id: number;
  readonly name: string;
}
export interface KcalRow {
  readonly calories: number;
}
export interface DaysRow {
  readonly order_days: number;
}

export interface CompanyRow {
  readonly company_id: string;
  readonly name: string | null;
}

/** One leaf row — a single (company, diet, tier, option, kcal) price observation. */
export interface LeafRow {
  readonly company_id: string;
  readonly diet_id: number;
  readonly diet_name: string | null;
  readonly diet_tag: string | null;
  readonly diet_description: string | null;
  readonly tier_id: number | null;
  readonly tier_name: string | null;
  readonly diet_option_id: number | null;
  readonly diet_option_name: string | null;
  readonly diet_calories_id: number;
  readonly calories: number | null;
  readonly per_day_cost: string | null;
  readonly per_day_cost_with_discounts: string | null;
  readonly total_cost: string | null;
  readonly total_cost_without_discounts: string | null;
  readonly total_delivery_cost: string | null;
  readonly total_promo_code_discount: string | null;
  readonly total_order_length_discount: string | null;
  readonly promo_codes: readonly string[] | null;
  readonly applied_promo_codes: readonly string[] | null;
  readonly effective_per_day: string | null;
  readonly captured_at: string;
  readonly prev_per_day: string | null;
}

/** A catering "tile" — one company, with its cheapest leaf surfaced. */
export interface CateringTile {
  readonly company_id: string;
  readonly company_name: string | null;
  readonly awarded: boolean | null;
  readonly feedback_value: string | null;
  readonly feedback_number: number | null;
  /** The single cheapest leaf for this company in the kcal range. */
  readonly cheapest: LeafRow;
  /** All leaves for this company in the kcal range, sorted asc by price. */
  readonly leaves: readonly LeafRow[];
}

export interface CateringPage {
  readonly tiles: readonly CateringTile[];
  /** total number of companies that have at least one leaf in range */
  readonly total: number;
  /** 1-indexed */
  readonly page: number;
  readonly pageSize: number;
  /** cheapest per-day price across ALL pages, for the header summary */
  readonly rangeMin: number | null;
  /** costliest per-day price across ALL pages */
  readonly rangeMax: number | null;
}

export interface CampaignRow {
  readonly id: number;
  readonly code: string | null;
  readonly title: string | null;
  readonly starts_at: string | null;
  readonly ends_at: string | null;
  readonly discount_percent: string | null;
  readonly is_active: boolean;
  readonly first_seen_at: string | null;
  readonly last_seen_at: string | null;
  readonly company_id: string | null;
}

export interface PriceHistoryPoint {
  /** ISO date */
  readonly bucket: string;
  readonly price: number;
  readonly promo_codes: readonly string[] | null;
}

export interface VariantMealRow {
  readonly slot_name: string;
  readonly meal_id: number;
  readonly name: string;
  readonly label: string | null;
  readonly kcal: number | null;
  readonly protein_g: number | null;
  readonly fat_g: number | null;
  readonly carbs_g: number | null;
  readonly image_url: string | null;
  readonly allergens: readonly string[] | null;
  /** YYYY-MM-DD */
  readonly last_seen_date: string;
  readonly occurrences: number;
}

// ── 1. Cities ───────────────────────────────────────────────────────────────

export const getCities = async (): Promise<CityRow[]> => {
  const rows = await query<CityRow>(
    `SELECT city_id::int AS city_id, name
     FROM cities
     WHERE EXISTS (SELECT 1 FROM company_cities cc WHERE cc.city_id = cities.city_id)
     ORDER BY name ASC`
  );
  return rows;
};

// ── 2. Kcal range bounds for a city ─────────────────────────────────────────

export interface KcalBounds {
  min: number;
  max: number;
  /** Distinct kcal values with enough data to be useful as preset chips. */
  presets: number[];
}

const PRESET_CANDIDATES = [1200, 1500, 1800, 2000, 2500];
// Filter junk like 6000/10000 outliers from filter UI.
const KCAL_HARD_CAP = 4000;

export const getKcalBounds = async (cityId: number): Promise<KcalBounds> => {
  const [bounds] = await query<{ min: number | null; max: number | null }>(
    `SELECT
        MIN(dc.calories)::int AS min,
        MAX(dc.calories)::int AS max
     FROM diet_calories dc
     JOIN company_cities cc ON cc.company_id = dc.company_id
     WHERE cc.city_id = $1
       AND dc.calories IS NOT NULL
       AND dc.calories <= $2
       AND dc.is_active = TRUE`,
    [cityId, KCAL_HARD_CAP]
  );

  // Which presets actually have data in this city?
  const hits = await query<{ readonly calories: number }>(
    `SELECT DISTINCT dc.calories
     FROM diet_calories dc
     JOIN company_cities cc ON cc.company_id = dc.company_id
     WHERE cc.city_id = $1
       AND dc.calories = ANY($2::int[])
       AND dc.is_active = TRUE`,
    [cityId, PRESET_CANDIDATES]
  );
  const present = new Set(hits.map((h) => h.calories));
  const presets = PRESET_CANDIDATES.filter((p) => present.has(p));

  return {
    max: bounds?.max ?? 3000,
    min: bounds?.min ?? 1000,
    presets: presets.length ? presets : PRESET_CANDIDATES,
  };
};

// ── 3. Day options for a city ───────────────────────────────────────────────

export const getDayOptions = async (cityId: number): Promise<number[]> => {
  const rows = await query<DaysRow>(
    `SELECT DISTINCT order_days
     FROM prices
     WHERE city_id = $1
     ORDER BY order_days ASC`,
    [cityId]
  );
  return rows.map((r) => r.order_days);
};

// ── 4. The catering page (flat tiles, paginated) ────────────────────────────
//
// One row per company in the city. Each row carries:
//   - the cheapest leaf (for ranking + the collapsed display)
//   - every leaf in range (for the drill-down table; sorted asc)
//   - rating / awarded info from the companies table
// `total` is the total number of companies in range (for pagination).

const PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;

export const getCateringPage = async (
  args: Readonly<{
    cityId: number;
    kcalMin: number;
    kcalMax: number;
    days: number;
    /** 1-indexed */
    page: number;
    pageSize?: number;
  }>
): Promise<CateringPage> => {
  const { cityId, kcalMin, kcalMax, days } = args;
  const page = Math.max(1, args.page);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, args.pageSize ?? PAGE_SIZE)
  );
  const offset = (page - 1) * pageSize;

  // We DISTINCT ON (company, dc_id, tier|null, option|null, days) to capture
  // the latest capture per real combo (the same dc_id can appear under
  // multiple tiers — verified live: different prices). Then we filter by
  // calories range, group per company, sort ascending by cheapest.
  interface PageRow {
    readonly company_id: string;
    readonly company_name: string | null;
    readonly awarded: boolean | null;
    readonly feedback_value: string | null;
    readonly feedback_number: number | null;
    /** numeric cast — comparable for ordering */
    readonly cheapest: string;
    /** jsonb agg */
    readonly leaves: string;
    readonly total_companies: number;
    readonly overall_min: string | null;
    readonly overall_max: string | null;
  }

  const rows = await query<PageRow>(
    `
    -- 1. Bucket each price row by its capture day, and within each
    --    (combo, day) pick the row with MIN(total_cost). Order-length and
    --    promo-code discounts DO NOT stack — the API picks whichever is
    --    better — so the cheapest variant on a given day IS the offer.
    WITH cheapest_per_day AS (
      SELECT DISTINCT ON (
        p.company_id, p.diet_calories_id,
        COALESCE(p.tier_diet_option_id, ''), p.order_days,
        date_trunc('day', p.captured_at)
      )
        p.*,
        date_trunc('day', p.captured_at) AS capture_day
      FROM prices p
      WHERE p.city_id    = $1
        AND p.order_days = $2
      ORDER BY
        p.company_id, p.diet_calories_id,
        COALESCE(p.tier_diet_option_id, ''), p.order_days,
        date_trunc('day', p.captured_at),
        p.total_cost ASC NULLS LAST,
        p.captured_at DESC, p.id DESC
    ),
    -- 2. Among day-buckets per combo, rn=1 is current, rn=2 is prev.
    ranked AS (
      SELECT
        c.*,
        ROW_NUMBER() OVER (
          PARTITION BY c.company_id, c.diet_calories_id,
                       COALESCE(c.tier_diet_option_id, ''), c.order_days
          ORDER BY c.capture_day DESC
        ) AS rn
      FROM cheapest_per_day c
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
        r.total_delivery_cost::text             AS total_delivery_cost,
        r.total_promo_code_discount::text       AS total_promo_code_discount,
        r.total_order_length_discount::text     AS total_order_length_discount,
        r.promo_codes,
        r.promo_codes                           AS applied_promo_codes,
        r.captured_at::text                     AS captured_at,
        -- Effective per-day = (food + delivery) / days, the truthful number.
        ((r.total_cost / NULLIF(r.order_days, 0))::numeric(10,2))::text AS effective_per_day,
        ((r.total_cost / NULLIF(r.order_days, 0))::numeric(10,2))       AS effective_per_day_num,
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
        AND dc.is_active = TRUE
        AND d.is_active  = TRUE
    ),
    -- Previous (rn = 2) day-bucket capture, for the price delta arrow.
    -- We compare effective per-day (total/days) so the delta reflects the
    -- truthful price the user pays today vs. previously.
    prev AS (
      SELECT
        company_id, diet_calories_id,
        COALESCE(tier_diet_option_id, '') AS tdo_key,
        order_days,
        ((total_cost / NULLIF(order_days, 0))::numeric(10,2))::text AS prev_per_day
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
        MIN(e.effective_per_day_num) AS cheapest_num,
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
            'total_delivery_cost',           e.total_delivery_cost,
            'total_promo_code_discount',     e.total_promo_code_discount,
            'total_order_length_discount',   e.total_order_length_discount,
            'promo_codes',                   e.promo_codes,
            'applied_promo_codes',           e.applied_promo_codes,
            'effective_per_day',             e.effective_per_day,
            'captured_at',                   e.captured_at,
            'prev_per_day',                  e.prev_per_day
          )
          ORDER BY e.effective_per_day_num ASC, e.calories ASC
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
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON.parse returns any; row schema enforced by SQL projection
    const leaves = JSON.parse(r.leaves) as LeafRow[];
    return {
      awarded: r.awarded,
      cheapest: leaves[0],
      company_id: r.company_id,
      company_name: r.company_name,
      feedback_number: r.feedback_number,
      feedback_value: r.feedback_value,
      leaves,
    };
  });

  const total = rows[0]?.total_companies ?? 0;
  const overallMin = rows[0]?.overall_min ?? null;
  const overallMax = rows[0]?.overall_max ?? null;

  return {
    page,
    pageSize,
    rangeMax:
      overallMax === null || overallMax === ""
        ? null
        : Number.parseFloat(overallMax),
    rangeMin:
      overallMin === null || overallMin === ""
        ? null
        : Number.parseFloat(overallMin),
    tiles,
    total,
  };
};

// ── 5. Active campaigns ─────────────────────────────────────────────────────

export const getActiveCampaigns = async (): Promise<CampaignRow[]> => {
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
};

// ── 6. Price history for one (company, diet_calories, city, days) combo ────

// ── 7. Variant meals — what's been on the menu in the last 14 days ─────────

export const getVariantMeals = async (
  args: Readonly<{
    companyId: string;
    dietCaloriesId: number;
    tierId: number | null;
  }>
): Promise<VariantMealRow[]> => {
  const { companyId, dietCaloriesId, tierId } = args;
  // The menu scraper writes a single canonical menu per (tier_id, diet_option_id),
  // typically at the LOWEST kcal in that group. Sibling leaves (same option,
  // different kcal) share the same dish lineup with only portion sizes differing,
  // so meals_by_dc_id is sparse. Look up the (tier_id, diet_option_id) of the
  // requested leaf and pull menus from any sibling under that same option.
  const rows = await query<VariantMealRow>(
    `
    WITH target AS (
      SELECT diet_id, tier_id, diet_option_id
      FROM diet_calories
      WHERE company_id = $1 AND diet_calories_id = $2
      ORDER BY (COALESCE(tier_id::text,'') = COALESCE($3::int::text,'')) DESC
      LIMIT 1
    ),
    siblings AS (
      SELECT dc.diet_calories_id
      FROM diet_calories dc, target t
      WHERE dc.company_id = $1
        AND dc.diet_id = t.diet_id
        AND COALESCE(dc.tier_id, -1)        = COALESCE(t.tier_id, -1)
        AND COALESCE(dc.diet_option_id, -1) = COALESCE(t.diet_option_id, -1)
    )
    SELECT
      dm.slot_name,
      m.id::int                                    AS meal_id,
      m.name,
      m.label,
      m.kcal::float                                AS kcal,
      m.protein_g::float                           AS protein_g,
      m.fat_g::float                               AS fat_g,
      m.carbs_g::float                             AS carbs_g,
      m.image_url,
      m.allergens,
      to_char(MAX(dm.menu_date), 'YYYY-MM-DD')     AS last_seen_date,
      COUNT(DISTINCT dm.menu_date)::int            AS occurrences
    FROM daily_menu dm
    JOIN meals m ON m.id = dm.meal_id
    WHERE dm.company_id       = $1
      AND dm.diet_calories_id IN (SELECT diet_calories_id FROM siblings)
      AND dm.menu_date >= CURRENT_DATE - INTERVAL '14 days'
    GROUP BY dm.slot_name, m.id, m.name, m.label, m.kcal, m.protein_g, m.fat_g, m.carbs_g, m.image_url, m.allergens
    ORDER BY dm.slot_name,
             COUNT(DISTINCT dm.menu_date) DESC,
             MAX(dm.menu_date) DESC,
             m.name
    `,
    [companyId, dietCaloriesId, tierId]
  );
  return rows;
};

// ── 8. Per-day ranked offers (preferences-aware scoring) ───────────────────
//
// Implements the design at `plan-for-nown-tingly-dragonfly.md` lines 646–728:
//   1. Router (`routePreferences`) parses prefer/avoid arrays into four
//      intent buckets (allergen, category, macro, embedding).
//   2. We bind those buckets as parallel arrays and `UNNEST` them inside the
//      query, so the whole scoring round-trip is a single SQL call.
//   3. CTE chain: offer_slots → kcal-filtered → per-source hits → per-option
//      score (signed sum) → per-slot resolution (best + default) → per-offer
//      verdict → metadata join (company/diet/tier/calories/price) → sort.
//   4. `considered_count` is exposed via `COUNT(*) OVER ()` so we get it in
//      the same round-trip without a second query.
//
// Important data shape notes (verified against the live robinfood/Wrocław
// dataset):
//   - Fixed diets (`is_menu_configuration = false`) use sentinel
//     `tier_id = 0, diet_option_id = 0` in `diet_calories` (NOT NULL). That
//     diverges from what `schema.sql` comments suggest but matches reality;
//     `tier_diet_option_id` is the literal `"0-0"` for these.
//   - `meals.allergens` stores Polish-native strings with **mixed case**
//     ('jajka', 'Sezam', 'Orzeszki ziemne (arachidowe)'). The router emits
//     lowercase names from a fixed lexicon, so we compare case-insensitively
//     via `LOWER(...)` to avoid false misses.
//   - Macro percentiles are computed on `macro / (kcal/100)` (i.e. macro per
//     100 kcal), per the plan spec at lines 66–67.

export interface PreferenceHit {
  readonly source: "allergen" | "category" | "macro" | "embedding";
  readonly keyword: string;
  readonly channel: "prefer" | "avoid";
  /** 0..1 */
  readonly penalty: number;
  /** signed */
  readonly contribution: number;
  /** human-readable */
  readonly reason: string;
}

export interface MealScore {
  readonly meal_id: number;
  readonly meal_name: string;
  readonly score: number;
  readonly hits: readonly PreferenceHit[];
}

export interface DayPick {
  readonly slot_name: string;
  readonly is_default: boolean;
  readonly meal: MealScore;
}

export interface DayVerdict {
  readonly score_default: number;
  readonly score_best: number;
  readonly n_slots: number;
}

export interface RankedDayOffer {
  readonly offer_id: string;
  readonly company: { readonly id: string; readonly name: string | null };
  readonly diet: { readonly name: string | null; readonly tag: string | null };
  readonly tier: { readonly name: string | null } | null;
  readonly is_menu_configuration: boolean;
  readonly calories: number | null;
  readonly price_per_day: number | null;
  readonly picks: readonly DayPick[];
  readonly picks_default: readonly DayPick[] | null;
  readonly verdict: DayVerdict;
}

// Discriminate macro field op as a stable string label suitable for SQL
// UNNEST. We collapse the four MacroOp shapes into:
//   'high' | 'low' for percentile predicates (value column is NULL)
//   'max' | 'min'  for kcal threshold predicates (value column carries N)
type MacroOpLabel = "high" | "low" | "max" | "min";

interface MacroParam {
  readonly keyword: string;
  readonly field: MacroField;
  readonly op: MacroOpLabel;
  readonly value: number | null;
  readonly channel: "prefer" | "avoid";
}

// ── Row shapes returned by the big query ───────────────────────────────────
interface RankedRow {
  readonly offer_id_company: string;
  readonly offer_id_dc: number;
  readonly offer_id_tdo: string | null;
  readonly company_id: string;
  readonly company_name: string | null;
  readonly diet_name: string | null;
  readonly diet_tag: string | null;
  readonly tier_name: string | null;
  readonly is_menu_configuration: boolean;
  readonly calories: number | null;
  readonly price_per_day: string | null;
  readonly score_best: string;
  readonly score_default: string;
  readonly n_slots: number;
  readonly picks_json: string;
  readonly picks_default_json: string;
  readonly considered_count: number;
}

interface PickJsonShape {
  readonly slot_name: string;
  readonly meal: {
    readonly meal_id: number;
    readonly meal_name: string;
    readonly is_default: boolean;
    readonly score: number | string;
    readonly hits: readonly PreferenceHit[];
  };
}

const intentParamsFromRouter = (
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- RoutedIntents already declares all fields readonly; lint engine can't see through the imported alias
  intents: RoutedIntents
): {
  readonly allergenKeywords: string[];
  readonly allergenNames: string[];
  readonly allergenChannels: string[];
  readonly categoryKeywords: string[];
  readonly categoryCategories: string[];
  readonly categoryChannels: string[];
  readonly categoryPatterns: string[];
  readonly macros: readonly MacroParam[];
  readonly macroKeywords: string[];
  readonly macroFields: string[];
  readonly macroOps: string[];
  readonly macroValues: (number | null)[];
  readonly macroChannels: string[];
  readonly embKeywords: string[];
  readonly embChannels: string[];
  readonly embVectors: string[];
} => {
  const allergenKeywords: string[] = [];
  const allergenNames: string[] = [];
  const allergenChannels: string[] = [];
  for (const a of intents.allergen) {
    allergenKeywords.push(a.keyword);
    allergenNames.push(a.allergen);
    allergenChannels.push(a.channel);
  }

  // Category intents fan out — one parallel-row per (category, pattern). If a
  // category has zero patterns it contributes nothing (no rows for it), which
  // matches the spec.
  const categoryKeywords: string[] = [];
  const categoryCategories: string[] = [];
  const categoryChannels: string[] = [];
  const categoryPatterns: string[] = [];
  for (const c of intents.category) {
    for (const pattern of c.patterns) {
      categoryKeywords.push(c.keyword);
      categoryCategories.push(c.category);
      categoryChannels.push(c.channel);
      // Wrap the (already-lowercased) pattern in SQL LIKE wildcards. The
      // taxonomy stores raw substrings (e.g. 'pomidor'); we use `%X%` so any
      // occurrence in `meal_ingredients.name_normalized` matches.
      categoryPatterns.push(`%${pattern}%`);
    }
  }

  const macros: MacroParam[] = intents.macro.map((m) => {
    const { op } = m;
    if (op.kind === "max" || op.kind === "min") {
      return {
        channel: m.channel,
        field: m.field,
        keyword: m.keyword,
        op: op.kind,
        value: op.value,
      };
    }
    return {
      channel: m.channel,
      field: m.field,
      keyword: m.keyword,
      op: op.kind,
      value: null,
    };
  });
  const macroKeywords = macros.map((m) => m.keyword);
  const macroFields = macros.map((m) => m.field);
  const macroOps = macros.map((m) => m.op);
  const macroValues = macros.map((m) => m.value);
  const macroChannels = macros.map((m) => m.channel);

  const embKeywords: string[] = [];
  const embChannels: string[] = [];
  const embVectors: string[] = [];
  for (const e of intents.embedding) {
    embKeywords.push(e.keyword);
    embChannels.push(e.channel);
    embVectors.push(toPgVector(e.vector));
  }

  return {
    allergenChannels,
    allergenKeywords,
    allergenNames,
    categoryCategories,
    categoryChannels,
    categoryKeywords,
    categoryPatterns,
    embChannels,
    embKeywords,
    embVectors,
    macroChannels,
    macroFields,
    macroKeywords,
    macroOps,
    macroValues,
    macros,
  };
};

const decodePicks = (picksJson: string, hitsScale: number): DayPick[] => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- jsonb_agg projection
  const arr = JSON.parse(picksJson) as readonly PickJsonShape[];
  // SQL emits hits with already-signed `contribution`. We keep them as-is.
  // `hitsScale` is reserved for future re-weighting; today it's 1.
  return arr
    .filter((row) => row.meal !== null && row.meal !== undefined)
    .map((row) => ({
      is_default: row.meal.is_default,
      meal: {
        hits: row.meal.hits ?? [],
        meal_id: row.meal.meal_id,
        meal_name: row.meal.meal_name,
        score: Number(row.meal.score) * hitsScale,
      },
      slot_name: row.slot_name,
    }));
};

export const getRankedOffersForDay = async (
  args: Readonly<{
    cityId: number;
    date: string;
    prefer: readonly string[];
    avoid: readonly string[];
    kcalMin?: number;
    kcalMax?: number;
    orderDays?: number;
    limit?: number;
    weights?: { readonly prefer?: number; readonly avoid?: number };
  }>
): Promise<{
  readonly offers: readonly RankedDayOffer[];
  readonly considered_count: number;
}> => {
  const orderDays = args.orderDays ?? 5;
  const limit = args.limit ?? 10;
  const wPrefer = args.weights?.prefer ?? 1;
  const wAvoid = args.weights?.avoid ?? 1;

  const intents = await routePreferences({
    avoid: args.avoid,
    prefer: args.prefer,
  });

  const p = intentParamsFromRouter(intents);

  // The query binds parameters by 1-indexed `$N`. The order below maps
  // verbatim onto the SQL bindings:
  //   $1  cityId            $9  allergenKeywords   $16 macroKeywords
  //   $2  date              $10 allergenNames      $17 macroFields
  //   $3  kcalMin           $11 allergenChannels   $18 macroOps
  //   $4  kcalMax           $12 categoryKeywords   $19 macroValues
  //   $5  orderDays         $13 categoryCategories $20 macroChannels
  //   $6  limit             $14 categoryChannels   $21 embKeywords
  //   $7  wPrefer           $15 categoryPatterns   $22 embChannels
  //   $8  wAvoid                                   $23 embVectors
  const params: readonly unknown[] = [
    args.cityId,
    args.date,
    args.kcalMin ?? null,
    args.kcalMax ?? null,
    orderDays,
    limit,
    wPrefer,
    wAvoid,
    p.allergenKeywords,
    p.allergenNames,
    p.allergenChannels,
    p.categoryKeywords,
    p.categoryCategories,
    p.categoryChannels,
    p.categoryPatterns,
    p.macroKeywords,
    p.macroFields,
    p.macroOps,
    p.macroValues,
    p.macroChannels,
    p.embKeywords,
    p.embChannels,
    p.embVectors,
  ];

  const sql = `
    WITH
    -- ── Step A: per-(offer, slot, meal-option) candidate rows for the day
    offer_slots AS (
      SELECT
        cdm.company_id,
        cdm.diet_calories_id,
        cdm.tier_id,
        cdm.slot_name,
        cdm.meal_id,
        cdm.is_default
      FROM current_daily_menu cdm
      WHERE cdm.city_id    = $1
        AND cdm.menu_date  = $2::date
        AND cdm.meal_id IS NOT NULL
    ),
    -- ── Step B: kcal filter via diet_calories metadata
    offer_slots_kcal AS (
      SELECT os.*
      FROM offer_slots os
      JOIN diet_calories dc ON dc.diet_calories_id = os.diet_calories_id
      WHERE ($3::int IS NULL OR dc.calories >= $3)
        AND ($4::int IS NULL OR dc.calories <= $4)
    ),
    -- Distinct meal_ids actually referenced — narrows downstream JOINs to a
    -- handful of meals instead of the full table.
    candidate_meals AS (
      SELECT DISTINCT meal_id FROM offer_slots_kcal
    ),
    -- ── Step C1: allergen hits
    allergen_intents AS (
      SELECT keyword, allergen, channel
      FROM UNNEST($9::text[], $10::text[], $11::text[])
           AS t(keyword, allergen, channel)
    ),
    allergen_hits AS (
      SELECT
        osk.company_id, osk.diet_calories_id, osk.slot_name, osk.meal_id,
        'allergen'::text   AS source,
        ai.keyword         AS keyword,
        ai.channel         AS channel,
        1.0::numeric       AS penalty,
        ('allergen: ' || ai.allergen) AS reason
      FROM offer_slots_kcal osk
      JOIN meals m ON m.id = osk.meal_id
      JOIN allergen_intents ai ON TRUE
      WHERE m.allergens IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM UNNEST(m.allergens) AS a
          WHERE LOWER(a) = LOWER(ai.allergen)
        )
    ),
    -- ── Step C2: category hits via meal_ingredients LIKE patterns
    category_intents AS (
      SELECT keyword, category, channel, pattern
      FROM UNNEST($12::text[], $13::text[], $14::text[], $15::text[])
           AS t(keyword, category, channel, pattern)
    ),
    category_hits_raw AS (
      SELECT DISTINCT
        osk.company_id, osk.diet_calories_id, osk.slot_name, osk.meal_id,
        ci.keyword, ci.category, ci.channel,
        mi.name_normalized
      FROM offer_slots_kcal osk
      JOIN meal_ingredients mi ON mi.meal_id = osk.meal_id
      JOIN category_intents ci ON mi.name_normalized LIKE ci.pattern
    ),
    -- Aggregate: one hit per (offer, slot, meal, keyword) — collapse pattern
    -- duplicates so a meal with two matching ingredients doesn't score twice
    -- for the same keyword.
    category_hits AS (
      SELECT
        company_id, diet_calories_id, slot_name, meal_id,
        'category'::text AS source,
        keyword, channel,
        1.0::numeric     AS penalty,
        ('category: ' || category || ' ('
          || string_agg(DISTINCT name_normalized, ', ' ORDER BY name_normalized)
          || ')') AS reason
      FROM category_hits_raw
      GROUP BY company_id, diet_calories_id, slot_name, meal_id,
               keyword, channel, category
    ),
    -- ── Step C3: macro hits (per-100kcal percentiles + kcal thresholds)
    -- Build percentiles on the meals dataset once. per_100 = macro_g / (kcal/100).
    percentiles AS (
      SELECT
        percentile_cont(0.25) WITHIN GROUP (ORDER BY protein_g / NULLIF(kcal/100.0, 0)) AS protein_p25,
        percentile_cont(0.75) WITHIN GROUP (ORDER BY protein_g / NULLIF(kcal/100.0, 0)) AS protein_p75,
        percentile_cont(0.25) WITHIN GROUP (ORDER BY fat_g     / NULLIF(kcal/100.0, 0)) AS fat_p25,
        percentile_cont(0.75) WITHIN GROUP (ORDER BY fat_g     / NULLIF(kcal/100.0, 0)) AS fat_p75,
        percentile_cont(0.25) WITHIN GROUP (ORDER BY carbs_g   / NULLIF(kcal/100.0, 0)) AS carbs_p25,
        percentile_cont(0.75) WITHIN GROUP (ORDER BY carbs_g   / NULLIF(kcal/100.0, 0)) AS carbs_p75,
        percentile_cont(0.25) WITHIN GROUP (ORDER BY fiber_g   / NULLIF(kcal/100.0, 0)) AS fiber_p25,
        percentile_cont(0.75) WITHIN GROUP (ORDER BY fiber_g   / NULLIF(kcal/100.0, 0)) AS fiber_p75,
        percentile_cont(0.25) WITHIN GROUP (ORDER BY sugar_g   / NULLIF(kcal/100.0, 0)) AS sugar_p25,
        percentile_cont(0.75) WITHIN GROUP (ORDER BY sugar_g   / NULLIF(kcal/100.0, 0)) AS sugar_p75,
        percentile_cont(0.25) WITHIN GROUP (ORDER BY salt_g    / NULLIF(kcal/100.0, 0)) AS salt_p25,
        percentile_cont(0.75) WITHIN GROUP (ORDER BY salt_g    / NULLIF(kcal/100.0, 0)) AS salt_p75,
        percentile_cont(0.25) WITHIN GROUP (ORDER BY kcal) AS kcal_p25,
        percentile_cont(0.75) WITHIN GROUP (ORDER BY kcal) AS kcal_p75
      FROM meals
      WHERE kcal IS NOT NULL AND kcal > 0
    ),
    macro_intents AS (
      SELECT keyword, field, op, value, channel
      FROM UNNEST($16::text[], $17::text[], $18::text[], $19::numeric[], $20::text[])
           AS t(keyword, field, op, value, channel)
    ),
    -- We CROSS JOIN percentiles (a single row), then JOIN macro_intents and
    -- evaluate one giant CASE that switches on (field, op). meals.kcal is
    -- required for any /100kcal derivation; the predicates degrade to FALSE
    -- when nulls are involved (kept explicit).
    macro_hits AS (
      SELECT
        osk.company_id, osk.diet_calories_id, osk.slot_name, osk.meal_id,
        'macro'::text   AS source,
        mi.keyword      AS keyword,
        mi.channel      AS channel,
        1.0::numeric    AS penalty,
        ('macro: ' || mi.field || ' ' || mi.op
          || CASE WHEN mi.value IS NULL THEN '' ELSE ' ' || mi.value::text END)
                       AS reason
      FROM offer_slots_kcal osk
      JOIN meals m ON m.id = osk.meal_id
      JOIN macro_intents mi ON TRUE
      CROSS JOIN percentiles p
      WHERE
        -- kcal direct thresholds (max/min) — value column carries the N kcal.
        (mi.field = 'kcal' AND mi.op = 'max' AND m.kcal IS NOT NULL AND m.kcal <= mi.value)
     OR (mi.field = 'kcal' AND mi.op = 'min' AND m.kcal IS NOT NULL AND m.kcal >= mi.value)
        -- kcal high/low — compare against dataset percentile of kcal itself.
     OR (mi.field = 'kcal' AND mi.op = 'high' AND m.kcal IS NOT NULL AND m.kcal >= p.kcal_p75)
     OR (mi.field = 'kcal' AND mi.op = 'low'  AND m.kcal IS NOT NULL AND m.kcal <= p.kcal_p25)
        -- protein per 100kcal
     OR (mi.field = 'protein_g' AND mi.op = 'high' AND m.protein_g IS NOT NULL AND m.kcal IS NOT NULL AND m.kcal > 0
         AND (m.protein_g / (m.kcal / 100.0)) >= p.protein_p75)
     OR (mi.field = 'protein_g' AND mi.op = 'low'  AND m.protein_g IS NOT NULL AND m.kcal IS NOT NULL AND m.kcal > 0
         AND (m.protein_g / (m.kcal / 100.0)) <= p.protein_p25)
        -- fat per 100kcal
     OR (mi.field = 'fat_g' AND mi.op = 'high' AND m.fat_g IS NOT NULL AND m.kcal IS NOT NULL AND m.kcal > 0
         AND (m.fat_g / (m.kcal / 100.0)) >= p.fat_p75)
     OR (mi.field = 'fat_g' AND mi.op = 'low'  AND m.fat_g IS NOT NULL AND m.kcal IS NOT NULL AND m.kcal > 0
         AND (m.fat_g / (m.kcal / 100.0)) <= p.fat_p25)
        -- carbs
     OR (mi.field = 'carbs_g' AND mi.op = 'high' AND m.carbs_g IS NOT NULL AND m.kcal IS NOT NULL AND m.kcal > 0
         AND (m.carbs_g / (m.kcal / 100.0)) >= p.carbs_p75)
     OR (mi.field = 'carbs_g' AND mi.op = 'low'  AND m.carbs_g IS NOT NULL AND m.kcal IS NOT NULL AND m.kcal > 0
         AND (m.carbs_g / (m.kcal / 100.0)) <= p.carbs_p25)
        -- fiber
     OR (mi.field = 'fiber_g' AND mi.op = 'high' AND m.fiber_g IS NOT NULL AND m.kcal IS NOT NULL AND m.kcal > 0
         AND (m.fiber_g / (m.kcal / 100.0)) >= p.fiber_p75)
     OR (mi.field = 'fiber_g' AND mi.op = 'low'  AND m.fiber_g IS NOT NULL AND m.kcal IS NOT NULL AND m.kcal > 0
         AND (m.fiber_g / (m.kcal / 100.0)) <= p.fiber_p25)
        -- sugar
     OR (mi.field = 'sugar_g' AND mi.op = 'high' AND m.sugar_g IS NOT NULL AND m.kcal IS NOT NULL AND m.kcal > 0
         AND (m.sugar_g / (m.kcal / 100.0)) >= p.sugar_p75)
     OR (mi.field = 'sugar_g' AND mi.op = 'low'  AND m.sugar_g IS NOT NULL AND m.kcal IS NOT NULL AND m.kcal > 0
         AND (m.sugar_g / (m.kcal / 100.0)) <= p.sugar_p25)
        -- salt
     OR (mi.field = 'salt_g' AND mi.op = 'high' AND m.salt_g IS NOT NULL AND m.kcal IS NOT NULL AND m.kcal > 0
         AND (m.salt_g / (m.kcal / 100.0)) >= p.salt_p75)
     OR (mi.field = 'salt_g' AND mi.op = 'low'  AND m.salt_g IS NOT NULL AND m.kcal IS NOT NULL AND m.kcal > 0
         AND (m.salt_g / (m.kcal / 100.0)) <= p.salt_p25)
    ),
    -- ── Step C4: embedding hits — cosine similarity above 0.80, rescaled to 0..1
    -- tau=0.80 and divisor 0.20 are calibrated for e5-small (dim 384).
    -- See EMBEDDINGS.md and bench:threshold for the sweep that picked them.
    -- If the production model changes, both numbers AND vector(384) must be updated.
    embedding_intents AS (
      SELECT keyword, channel, vec::vector(384) AS vec
      FROM UNNEST($21::text[], $22::text[], $23::text[])
           AS t(keyword, channel, vec)
    ),
    embedding_hits AS (
      SELECT
        osk.company_id, osk.diet_calories_id, osk.slot_name, osk.meal_id,
        'embedding'::text  AS source,
        ei.keyword         AS keyword,
        ei.channel         AS channel,
        -- Cosine sim = 1 - (a <=> b). Clip at 0.80 (e5-small's natural cutoff),
        -- rescale [0.80, 1.00] to [0, 1] via /0.20.
        GREATEST(0.0,
          (((1 - (cme.embedding <=> ei.vec))::numeric - 0.80) / 0.20)
        )                  AS penalty,
        ('embedding: ' || ei.keyword || ' (sim='
          || ROUND((1 - (cme.embedding <=> ei.vec))::numeric, 2)::text || ')')
                            AS reason
      FROM offer_slots_kcal osk
      JOIN current_meal_embeddings cme ON cme.meal_id = osk.meal_id
      JOIN embedding_intents ei ON TRUE
      WHERE (1 - (cme.embedding <=> ei.vec))::numeric >= 0.80
    ),
    -- ── Step D: union all hit sources, then per-option signed score
    all_hits AS (
      SELECT * FROM allergen_hits
      UNION ALL
      SELECT * FROM category_hits
      UNION ALL
      SELECT * FROM macro_hits
      UNION ALL
      SELECT * FROM embedding_hits
    ),
    per_option_score AS (
      SELECT
        osk.company_id, osk.diet_calories_id, osk.tier_id,
        osk.slot_name, osk.meal_id, osk.is_default,
        COALESCE(SUM(
          CASE WHEN h.channel = 'prefer' THEN  h.penalty * $7::numeric
               WHEN h.channel = 'avoid'  THEN -h.penalty * $8::numeric
               ELSE 0
          END
        ), 0)::numeric AS score,
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'source',        h.source,
              'keyword',       h.keyword,
              'channel',       h.channel,
              'penalty',       h.penalty,
              'contribution',  CASE WHEN h.channel = 'prefer'
                                      THEN  h.penalty * $7::numeric
                                   WHEN h.channel = 'avoid'
                                      THEN -h.penalty * $8::numeric
                                   ELSE 0
                               END,
              'reason',        h.reason
            )
          ) FILTER (WHERE h.source IS NOT NULL),
          '[]'::jsonb
        ) AS hits_json
      FROM offer_slots_kcal osk
      LEFT JOIN all_hits h
        ON  h.company_id       = osk.company_id
        AND h.diet_calories_id = osk.diet_calories_id
        AND h.slot_name        = osk.slot_name
        AND h.meal_id          = osk.meal_id
      GROUP BY osk.company_id, osk.diet_calories_id, osk.tier_id,
               osk.slot_name, osk.meal_id, osk.is_default
    ),
    -- ── Step E: per-slot — best option AND default option
    -- We pre-build the per-option jsonb once to avoid duplicating projection.
    option_payload AS (
      SELECT
        pos.company_id, pos.diet_calories_id, pos.tier_id,
        pos.slot_name, pos.meal_id, pos.is_default, pos.score,
        jsonb_build_object(
          'meal_id',    pos.meal_id,
          'meal_name',  m.name,
          'is_default', pos.is_default,
          'score',      pos.score,
          'hits',       pos.hits_json
        ) AS payload
      FROM per_option_score pos
      JOIN meals m ON m.id = pos.meal_id
    ),
    per_slot AS (
      SELECT
        op.company_id, op.diet_calories_id, op.tier_id, op.slot_name,
        (array_agg(op.payload
          ORDER BY op.score DESC NULLS LAST, op.meal_id ASC))[1] AS best_pick,
        MAX(op.score) FILTER (WHERE TRUE) AS best_score,
        -- Default: prefer the is_default=TRUE option; tiebreak by meal_id ASC.
        (array_agg(op.payload
          ORDER BY op.is_default DESC, op.meal_id ASC))[1]      AS default_pick,
        (array_agg(op.score
          ORDER BY op.is_default DESC, op.meal_id ASC))[1]      AS default_score
      FROM option_payload op
      GROUP BY op.company_id, op.diet_calories_id, op.tier_id, op.slot_name
    ),
    -- ── Step F: per-offer verdict
    per_offer AS (
      SELECT
        ps.company_id, ps.diet_calories_id, ps.tier_id,
        SUM(ps.best_score)    AS score_best,
        SUM(ps.default_score) AS score_default,
        COUNT(*)::int         AS n_slots,
        jsonb_agg(
          jsonb_build_object('slot_name', ps.slot_name, 'meal', ps.best_pick)
          ORDER BY ps.slot_name
        ) AS picks_json,
        jsonb_agg(
          jsonb_build_object('slot_name', ps.slot_name, 'meal', ps.default_pick)
          ORDER BY ps.slot_name
        ) AS picks_default_json
      FROM per_slot ps
      GROUP BY ps.company_id, ps.diet_calories_id, ps.tier_id
    ),
    -- ── Step G: latest price for (city, dc, order_days)
    priced AS (
      SELECT DISTINCT ON (p.diet_calories_id)
        p.diet_calories_id,
        p.per_day_cost_with_discounts AS price_per_day
      FROM prices p
      WHERE p.city_id    = $1
        AND p.order_days = $5::int
      ORDER BY p.diet_calories_id, p.captured_at DESC
    ),
    -- ── Step H: join metadata, sort, limit
    final AS (
      SELECT
        po.company_id                                       AS offer_id_company,
        po.diet_calories_id                                 AS offer_id_dc,
        CASE WHEN d.is_menu_configuration
             THEN ("do".tier_diet_option_id)
             ELSE NULL
        END                                                 AS offer_id_tdo,
        po.company_id,
        co.name                                             AS company_name,
        d.name                                              AS diet_name,
        d.diet_tag                                          AS diet_tag,
        t.name                                              AS tier_name,
        d.is_menu_configuration                             AS is_menu_configuration,
        dc.calories                                         AS calories,
        pr.price_per_day::text                              AS price_per_day,
        po.score_best::text                                 AS score_best,
        po.score_default::text                              AS score_default,
        po.n_slots                                          AS n_slots,
        po.picks_json::text                                 AS picks_json,
        po.picks_default_json::text                         AS picks_default_json,
        COUNT(*) OVER ()::int                               AS considered_count
      FROM per_offer po
      JOIN diet_calories dc ON dc.diet_calories_id = po.diet_calories_id
      JOIN diet_options "do"
        ON "do".company_id     = dc.company_id
       AND "do".diet_id        = dc.diet_id
       AND "do".tier_id        = dc.tier_id
       AND "do".diet_option_id = dc.diet_option_id
      JOIN tiers t
        ON t.company_id = "do".company_id
       AND t.diet_id    = "do".diet_id
       AND t.tier_id    = "do".tier_id
      JOIN diets d
        ON d.company_id = t.company_id
       AND d.diet_id    = t.diet_id
      JOIN companies co ON co.company_id = d.company_id
      LEFT JOIN priced pr ON pr.diet_calories_id = po.diet_calories_id
    )
    SELECT *
    FROM final
    ORDER BY score_best::numeric DESC NULLS LAST,
             score_default::numeric DESC NULLS LAST,
             price_per_day::numeric ASC NULLS LAST,
             offer_id_dc ASC
    LIMIT $6
  `;

  const rows = await query<RankedRow>(sql, params);
  const consideredCount = rows[0]?.considered_count ?? 0;

  const offers: RankedDayOffer[] = rows.map((r) => {
    const isMC = r.is_menu_configuration;
    const offer_id = encodeOfferId({
      company_id: r.offer_id_company,
      diet_calories_id: r.offer_id_dc,
      is_menu_configuration: isMC,
      tier_diet_option_id: r.offer_id_tdo ?? undefined,
    });

    const picks = decodePicks(r.picks_json, 1);
    const picksDefault = decodePicks(r.picks_default_json, 1);
    const scoreBest = Number(r.score_best);
    const scoreDefault = Number(r.score_default);

    // Per the plan: for fixed (non-menu-config) offers the default picks
    // mathematically equal the best picks, so we surface `null` to signal
    // "nothing to switch". For menu-config offers we always surface the
    // default array (even if it happens to equal best on this particular
    // day) so the UI can show "you'll get X if you don't customise".
    const picksDefaultOut: DayPick[] | null = isMC ? picksDefault : null;

    const verdict: DayVerdict = {
      n_slots: r.n_slots,
      score_best: scoreBest,
      score_default: scoreDefault,
    };

    const out: RankedDayOffer = {
      calories: r.calories,
      company: { id: r.company_id, name: r.company_name },
      diet: { name: r.diet_name, tag: r.diet_tag },
      is_menu_configuration: isMC,
      offer_id,
      picks,
      picks_default: picksDefaultOut,
      price_per_day:
        r.price_per_day === null ? null : Number.parseFloat(r.price_per_day),
      tier: r.tier_name === null ? null : { name: r.tier_name },
      verdict,
    };
    return out;
  });

  return { considered_count: consideredCount, offers };
};

// ── 9. Weekly plan ─────────────────────────────────────────────────────────
// Per-day argmax over `getRankedOffersForDay`. Bundle hint: if the same
// company tops or alternates ≥80% of days, surface its order-length-discounted
// price at `orderDays = dates.length`.

export interface PlannedDay {
  readonly date: string;
  readonly top: RankedDayOffer | null;
  readonly alternates: readonly RankedDayOffer[];
  readonly note: string | null;
}

export interface WeeklyPlan {
  readonly city: { readonly id: number; readonly name: string };
  readonly days: readonly PlannedDay[];
  readonly summary: {
    readonly avg_score_best: number;
    readonly distinct_caterings: number;
    readonly estimated_total_price: number;
    readonly bundle_hint: string | null;
  };
}

interface CityNameRow {
  readonly name: string;
}

interface BundlePriceRow {
  readonly per_day: string | null;
  readonly without_discounts: string | null;
}

// Tally how many days each company appears in (top + alternates, capped to
// top-3 per the plan's bundle-hint heuristic). Returns at most one company id
// per day, regardless of how many of its variants show up.
const tallyCompanyCoverage = (
  days: readonly PlannedDay[]
): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();
  for (const d of days) {
    const top3 = [d.top, ...d.alternates].slice(0, 3);
    const seen = new Set<string>();
    for (const offer of top3) {
      if (offer !== null && !seen.has(offer.company.id)) {
        seen.add(offer.company.id);
        counts.set(offer.company.id, (counts.get(offer.company.id) ?? 0) + 1);
      }
    }
  }
  return counts;
};

const pickTopCompany = (
  counts: Readonly<ReadonlyMap<string, number>>
): { readonly id: string; readonly count: number } | null => {
  let topId: string | null = null;
  let topCount = 0;
  for (const [id, count] of counts) {
    if (count > topCount) {
      topId = id;
      topCount = count;
    }
  }
  return topId === null ? null : { count: topCount, id: topId };
};

const formatBundleHint = (
  repName: string,
  daysLen: number,
  discounted: number,
  list: number | null
): string => {
  if (list !== null && list > 0) {
    const pct = Math.round(((list - discounted) / list) * 100);
    if (pct > 0) {
      return `${repName}: bundle (${daysLen} dni) drops price ${pct}%`;
    }
  }
  return `${repName}: bundle (${daysLen} dni) at ${discounted.toFixed(2)} zł/dzień`;
};

const computeBundleHint = async (
  cityId: number,
  days: readonly PlannedDay[],
  withTop: readonly PlannedDay[]
): Promise<string | null> => {
  if (days.length === 0 || withTop.length === 0) {
    return null;
  }
  const threshold = Math.ceil(days.length * 0.8);
  const counts = tallyCompanyCoverage(days);
  const top = pickTopCompany(counts);
  if (top === null || top.count < threshold) {
    return null;
  }
  const repOffer = withTop.find((d) => d.top?.company.id === top.id)?.top;
  if (!repOffer) {
    return null;
  }
  // diet_calories_id is the third colon-separated chunk of offer_id (v1:co:dc[:tdo]).
  const offerIdParts = repOffer.offer_id.split(":");
  const dc = Number.parseInt(offerIdParts[2], 10);
  if (!Number.isInteger(dc)) {
    return null;
  }
  const priceRows = await query<BundlePriceRow>(
    `SELECT DISTINCT ON (diet_calories_id)
        per_day_cost_with_discounts::text     AS per_day,
        per_day_cost::text                    AS without_discounts
     FROM prices
     WHERE city_id          = $1
       AND diet_calories_id = $2
       AND order_days       = $3
     ORDER BY diet_calories_id, captured_at DESC`,
    [cityId, dc, days.length]
  );
  const [row] = priceRows;
  if (row === undefined || row.per_day === null) {
    return null;
  }
  const discounted = Number.parseFloat(row.per_day);
  const list =
    row.without_discounts === null
      ? null
      : Number.parseFloat(row.without_discounts);
  const repName = repOffer.company.name ?? top.id;
  return formatBundleHint(repName, days.length, discounted, list);
};

export const getWeeklyPlan = async (
  args: Readonly<{
    cityId: number;
    dates: readonly string[];
    prefer: readonly string[];
    avoid: readonly string[];
    kcalMin?: number;
    kcalMax?: number;
    altLimit?: number;
    weights?: { readonly prefer?: number; readonly avoid?: number };
  }>
): Promise<WeeklyPlan> => {
  const altLimit = args.altLimit ?? 3;
  const perDayLimit = altLimit + 1;

  const cityRows = await query<CityNameRow>(
    `SELECT name FROM cities WHERE city_id = $1 LIMIT 1`,
    [args.cityId]
  );
  const cityName = cityRows[0]?.name ?? "";

  const dayResults: {
    offers: readonly RankedDayOffer[];
    considered_count: number;
  }[] = [];
  await Promise.all(
    args.dates.map(async (d, idx) => {
      const r = await getRankedOffersForDay({
        avoid: args.avoid,
        cityId: args.cityId,
        date: d,
        kcalMax: args.kcalMax,
        kcalMin: args.kcalMin,
        limit: perDayLimit,
        prefer: args.prefer,
        weights: args.weights,
      });
      dayResults[idx] = r;
    })
  );

  const days: PlannedDay[] = args.dates.map((date, i) => {
    const result = dayResults[i];
    const top = result.offers[0] ?? null;
    const alternates = result.offers.slice(1);
    return {
      alternates,
      date,
      note:
        result.offers.length === 0 ? "no menus captured for this date" : null,
      top,
    };
  });

  // Summary aggregates — guard against the all-empty case.
  const withTop = days.filter((d) => d.top !== null);
  const avgScoreBest =
    withTop.length === 0
      ? 0
      : withTop.reduce((acc, d) => acc + (d.top?.verdict.score_best ?? 0), 0) /
        withTop.length;
  const distinctCaterings = new Set(
    withTop
      .map((d) => d.top?.company.id)
      .filter((x): x is string => x !== undefined)
  ).size;
  const estimatedTotalPrice = withTop.reduce(
    (acc, d) => acc + (d.top?.price_per_day ?? 0),
    0
  );

  const bundleHint = await computeBundleHint(args.cityId, days, withTop);

  return {
    city: { id: args.cityId, name: cityName },
    days,
    summary: {
      avg_score_best: avgScoreBest,
      bundle_hint: bundleHint,
      distinct_caterings: distinctCaterings,
      estimated_total_price: estimatedTotalPrice,
    },
  };
};

export const getPriceHistory = async (
  args: Readonly<{
    companyId: string;
    dietCaloriesId: number;
    cityId: number;
    days: number;
  }>
): Promise<PriceHistoryPoint[]> => {
  const { companyId, dietCaloriesId, cityId, days } = args;
  const rows = await query<PriceHistoryPoint>(
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
  return rows;
};
