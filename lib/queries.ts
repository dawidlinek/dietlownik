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
  readonly source:
    | "allergen"
    | "category"
    | "macro"
    | "ingredient"
    | "embedding";
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
  readonly is_default: boolean;
  readonly score: number;
  readonly hits: readonly PreferenceHit[];
  readonly kcal: number | null;
  readonly protein_g: number | null;
  readonly fat_g: number | null;
  readonly carbs_g: number | null;
  readonly fiber_g: number | null;
  readonly sugar_g: number | null;
  readonly ingredients_raw: string | null;
  readonly allergens: readonly string[];
}

export interface DayPick {
  readonly slot_name: string;
  readonly is_default: boolean;
  readonly meal: MealScore;
  /** Other meals available in this slot — only populated for menu-config offers. */
  readonly alternates: readonly MealScore[] | null;
}

export interface DayVerdict {
  readonly score_default: number;
  readonly score_best: number;
  readonly n_slots: number;
}

export interface OfferPromo {
  readonly code: string;
  readonly discount_percent: number;
  readonly ends_at?: string;
}

export interface RankedDayOffer {
  readonly offer_id: string;
  readonly company: {
    readonly id: string;
    readonly name: string | null;
    readonly logo_url: string | null;
  };
  readonly diet: { readonly name: string | null; readonly tag: string | null };
  readonly tier: { readonly name: string | null } | null;
  readonly is_menu_configuration: boolean;
  readonly calories: number | null;
  readonly price_per_day: number | null;
  readonly price_per_day_before_promo: number | null;
  readonly promos: readonly OfferPromo[];
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
  readonly company_logo_url: string | null;
  readonly diet_name: string | null;
  readonly diet_tag: string | null;
  readonly tier_name: string | null;
  readonly is_menu_configuration: boolean;
  readonly calories: number | null;
  readonly price_per_day: string | null;
  readonly price_per_day_before_promo: string | null;
  readonly promos_json: string;
  readonly score_best: string;
  readonly score_default: string;
  readonly n_slots: number;
  readonly picks_json: string;
  readonly picks_default_json: string;
  readonly considered_count: number;
}

interface MealJsonShape {
  readonly meal_id: number;
  readonly meal_name: string;
  readonly is_default: boolean;
  readonly score: number | string;
  readonly hits: readonly PreferenceHit[];
  readonly kcal: number | string | null;
  readonly protein_g: number | string | null;
  readonly fat_g: number | string | null;
  readonly carbs_g: number | string | null;
  readonly fiber_g: number | string | null;
  readonly sugar_g: number | string | null;
  readonly ingredients_raw: string | null;
  readonly allergens: readonly string[] | null;
}

interface PickJsonShape {
  readonly slot_name: string;
  readonly meal: MealJsonShape;
  readonly options: readonly MealJsonShape[] | null;
}

interface PromoJsonShape {
  readonly code: string;
  readonly discount_percent: number | string;
  readonly ends_at: string | null;
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
  readonly ingredientKeywords: string[];
  readonly ingredientStems: string[];
  readonly ingredientChannels: string[];
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

  const ingredientKeywords: string[] = [];
  const ingredientStems: string[] = [];
  const ingredientChannels: string[] = [];
  for (const ing of intents.ingredient) {
    ingredientKeywords.push(ing.keyword);
    ingredientStems.push(ing.stem);
    ingredientChannels.push(ing.channel);
  }

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
    ingredientChannels,
    ingredientKeywords,
    ingredientStems,
    macroChannels,
    macroFields,
    macroKeywords,
    macroOps,
    macroValues,
    macros,
  };
};

const nullableNumber = (v: number | string | null): number | null => {
  if (v === null || v === undefined) {
    return null;
  }
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const decodeMeal = (m: MealJsonShape, hitsScale: number): MealScore => ({
  allergens: m.allergens ?? [],
  carbs_g: nullableNumber(m.carbs_g),
  fat_g: nullableNumber(m.fat_g),
  fiber_g: nullableNumber(m.fiber_g),
  hits: m.hits ?? [],
  ingredients_raw: m.ingredients_raw,
  is_default: m.is_default,
  kcal: nullableNumber(m.kcal),
  meal_id: m.meal_id,
  meal_name: m.meal_name,
  protein_g: nullableNumber(m.protein_g),
  score: Number(m.score) * hitsScale,
  sugar_g: nullableNumber(m.sugar_g),
});

const decodePicks = (
  picksJson: string,
  hitsScale: number,
  includeAlternates: boolean
): DayPick[] => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- jsonb_agg projection
  const arr = JSON.parse(picksJson) as readonly PickJsonShape[];
  return arr
    .filter((row) => row.meal !== null && row.meal !== undefined)
    .map((row) => {
      const meal = decodeMeal(row.meal, hitsScale);
      // `alternates` carries the FULL slot option pool — including the
      // currently-best meal. The UI swap popover filters out whichever meal
      // is currently selected at render time (initial best or post-swap), so
      // we must keep the full set here. Filtering out the best meal at this
      // level used to break the single-alternative case: clicking the only
      // alternate left the user with no way to revert to the default.
      let alternates: readonly MealScore[] | null = null;
      if (includeAlternates && row.options) {
        alternates = row.options.map((opt) => decodeMeal(opt, hitsScale));
      }
      return {
        alternates,
        is_default: row.meal.is_default,
        meal,
        slot_name: row.slot_name,
      };
    });
};

const decodePromos = (promosJson: string | null): OfferPromo[] => {
  if (promosJson === null || promosJson === "") {
    return [];
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- jsonb_agg projection
  const arr = JSON.parse(promosJson) as readonly PromoJsonShape[];
  return arr.map((p) => {
    const out: OfferPromo = {
      code: p.code,
      discount_percent: Number(p.discount_percent),
    };
    return p.ends_at === null || p.ends_at === undefined
      ? out
      : { ...out, ends_at: p.ends_at };
  });
};

// `LIMIT NULL` in Postgres is equivalent to no LIMIT clause; callers pass
// `0` to opt into "every ranked offer for this day" (the scatter on the home
// page needs it for honest top-5-by-any-axis).
const resolveRankedLimit = (raw: number | null | undefined): number | null => {
  if (raw === undefined) {
    return 10;
  }
  return raw === 0 ? null : raw;
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
    /** Pass `null` (or undefined to default to 10) for the standard top-N
     * behavior. Pass `0` for no limit — returns every ranked offer for the day,
     * needed by the home page's scatter (true top-5-by-any-axis requires the
     * full pool, not a top-N-by-score slice). */
    limit?: number | null;
    weights?: { readonly prefer?: number; readonly avoid?: number };
  }>
): Promise<{
  readonly offers: readonly RankedDayOffer[];
  readonly considered_count: number;
}> => {
  const orderDays = args.orderDays ?? 5;
  const limit: number | null = resolveRankedLimit(args.limit);
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
  //   $24 ingredientKeywords  $25 ingredientStems  $26 ingredientChannels
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
    p.ingredientKeywords,
    p.ingredientStems,
    p.ingredientChannels,
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
    -- Step B: kcal filter + canonical-menu fan-out via diet_calories metadata.
    --
    -- Two compounding data-model facts:
    --   1) diet_calories_id is NOT globally unique despite the BIGSERIAL PK
    --      current_daily_menu reuses small per-catering ids that collide across
    --      caterings, so we MUST constrain the join by company_id.
    --   2) The menus scraper only captures ONE menu per (tier, option, diet)
    --      family the lowest-kcal canonical sibling. Higher kcal tiers
    --      (2500, 3000) share the same dish lineup (only portion sizes
    --      differ), so we fan the canonical menu out to every active sibling
    --      and let prices join supply the per-tier per-day cost.
    offer_slots_kcal AS (
      SELECT
        os.company_id,
        sibling.diet_calories_id          AS diet_calories_id,
        sibling.tier_id,
        os.slot_name,
        os.meal_id,
        os.is_default
      FROM offer_slots os
      JOIN diet_calories canonical
        ON canonical.diet_calories_id = os.diet_calories_id
       AND canonical.company_id       = os.company_id
      JOIN diet_calories sibling
        ON sibling.company_id     = canonical.company_id
       AND sibling.diet_id        = canonical.diet_id
       AND sibling.tier_id        IS NOT DISTINCT FROM canonical.tier_id
       AND sibling.diet_option_id IS NOT DISTINCT FROM canonical.diet_option_id
       AND sibling.is_active      = TRUE
      WHERE ($3::int IS NULL OR sibling.calories >= $3)
        AND ($4::int IS NULL OR sibling.calories <= $4)
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
    -- ── Step C4: embedding hits — sim ≥ 0.80 mapped linearly to [0.5, 2.0].
    -- The 0.80 cutoff is the e5-small calibrated F1-optimal point
    -- (bench:threshold). Mapping output to [0.5, 2.0] rather than [0, 1]
    -- makes embedding hits land heavier than allergen/category/ingredient
    -- hits (which max at 1.0): a confident semantic match counts double.
    -- Rescale: penalty = 0.5 + ((sim - 0.80) / 0.20) * 1.5
    --   sim=0.80 → 0.5, sim=0.90 → 1.25, sim=1.00 → 2.0
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
        (0.5 + (((1 - (cme.embedding <=> ei.vec))::numeric - 0.80) / 0.20) * 1.5)
                           AS penalty,
        ('embedding: ' || ei.keyword || ' (sim='
          || ROUND((1 - (cme.embedding <=> ei.vec))::numeric, 2)::text || ')')
                            AS reason
      FROM offer_slots_kcal osk
      JOIN current_meal_embeddings cme ON cme.meal_id = osk.meal_id
      JOIN embedding_intents ei ON TRUE
      WHERE (1 - (cme.embedding <=> ei.vec))::numeric >= 0.80
    ),
    -- ── Step C5: ingredient hits — pg_trgm fuzzy match against the per-meal
    -- ingredient list AND the meal's display name. Uses gin_trgm_ops indexes
    -- on meal_ingredients.name_normalized and meals.name_normalized (the
    -- latter added in migrate_v9). The stem (diacritic-folded + lightly
    -- suffix-stripped via lib/polish-stem.ts) is what we feed to similarity()
    -- — trigram is lenient about morphological tails but benefits from the
    -- suffix folding for declined forms.
    --
    -- Two scopes feed one channel: ingredient-row matches catch substances
    -- ('pomidor', 'ser', 'kurczak'), and meal-name matches catch dish-level
    -- terms ('zupa', 'shake', 'pierogi'). We UNION them and aggregate to one
    -- hit per (offer, slot, meal, keyword) — the best-matching source wins,
    -- so multi-ingredient meals don't get double-counted.
    ingredient_intents AS (
      SELECT keyword, stem, channel
      FROM UNNEST($24::text[], $25::text[], $26::text[])
           AS t(keyword, stem, channel)
    ),
    ingredient_hits_raw AS (
      -- ingredient-row matches
      SELECT
        osk.company_id, osk.diet_calories_id, osk.slot_name, osk.meal_id,
        ii.keyword, ii.channel, ii.stem,
        mi.name_normalized AS matched_text,
        similarity(mi.name_normalized, ii.stem)::numeric AS sim
      FROM offer_slots_kcal osk
      JOIN meal_ingredients mi ON mi.meal_id = osk.meal_id
      JOIN ingredient_intents ii ON mi.name_normalized % ii.stem
      WHERE similarity(mi.name_normalized, ii.stem) >= 0.45
      UNION ALL
      -- meal-name matches
      SELECT
        osk.company_id, osk.diet_calories_id, osk.slot_name, osk.meal_id,
        ii.keyword, ii.channel, ii.stem,
        m.name_normalized AS matched_text,
        similarity(m.name_normalized, ii.stem)::numeric AS sim
      FROM offer_slots_kcal osk
      JOIN meals m ON m.id = osk.meal_id
      JOIN ingredient_intents ii ON m.name_normalized % ii.stem
      WHERE similarity(m.name_normalized, ii.stem) >= 0.45
    ),
    ingredient_hits AS (
      SELECT
        company_id, diet_calories_id, slot_name, meal_id,
        'ingredient'::text AS source,
        keyword, channel,
        MAX(sim)::numeric  AS penalty,
        ('ingredient: ' || keyword || ' ('
          || (array_agg(matched_text ORDER BY sim DESC))[1]
          || ' sim='
          || ROUND(MAX(sim)::numeric, 2)::text || ')') AS reason
      FROM ingredient_hits_raw
      GROUP BY company_id, diet_calories_id, slot_name, meal_id,
               keyword, channel
    ),
    -- ── Step C6: suppress embedding hits when the ingredient channel already
    -- fired for the same (meal, keyword). Both channels matching the same
    -- term — e.g. 'ciecierzyca' showing up as both an ingredient row and a
    -- semantic embedding match — produced confusing double-counted rows.
    -- Ingredient is the more specific signal (literal-word lexical match),
    -- so it wins; embedding becomes redundant for that pair.
    embedding_hits_filtered AS (
      SELECT eh.*
      FROM embedding_hits eh
      WHERE NOT EXISTS (
        SELECT 1
        FROM ingredient_hits ih
        WHERE ih.company_id       = eh.company_id
          AND ih.diet_calories_id = eh.diet_calories_id
          AND ih.slot_name        = eh.slot_name
          AND ih.meal_id          = eh.meal_id
          AND ih.keyword          = eh.keyword
      )
    ),
    -- ── Step D: union all hit sources, then per-option signed score
    all_hits AS (
      SELECT * FROM allergen_hits
      UNION ALL
      SELECT * FROM category_hits
      UNION ALL
      SELECT * FROM macro_hits
      UNION ALL
      SELECT * FROM ingredient_hits
      UNION ALL
      SELECT * FROM embedding_hits_filtered
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
    -- The payload now carries the meal's macros + ingredients + allergens
    -- (so the UI can render macros and the swap popover without a second round-trip).
    option_payload AS (
      SELECT
        pos.company_id, pos.diet_calories_id, pos.tier_id,
        pos.slot_name, pos.meal_id, pos.is_default, pos.score,
        jsonb_build_object(
          'meal_id',         pos.meal_id,
          'meal_name',       m.name,
          'is_default',      pos.is_default,
          'score',           pos.score,
          'hits',            pos.hits_json,
          'kcal',            m.kcal,
          'protein_g',       m.protein_g,
          'fat_g',           m.fat_g,
          'carbs_g',         m.carbs_g,
          'fiber_g',         m.fiber_g,
          'sugar_g',         m.sugar_g,
          'ingredients_raw', m.ingredients_raw,
          'allergens',       COALESCE(m.allergens, ARRAY[]::TEXT[])
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
          ORDER BY op.is_default DESC, op.meal_id ASC))[1]      AS default_score,
        -- ALL options for this slot, score-descending. Used as alternates in
        -- the swap popover for menu-config offers.
        jsonb_agg(op.payload
          ORDER BY op.score DESC NULLS LAST, op.meal_id ASC)     AS options_json
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
          jsonb_build_object(
            'slot_name', ps.slot_name,
            'meal',      ps.best_pick,
            'options',   ps.options_json
          )
          ORDER BY ps.slot_name
        ) AS picks_json,
        jsonb_agg(
          jsonb_build_object(
            'slot_name', ps.slot_name,
            'meal',      ps.default_pick,
            'options',   ps.options_json
          )
          ORDER BY ps.slot_name
        ) AS picks_default_json
      FROM per_slot ps
      GROUP BY ps.company_id, ps.diet_calories_id, ps.tier_id
    ),
    -- ── Step G: latest price for (city, dc), with promo metadata.
    -- Prefer the requested order_days, but fall back to ANY captured duration
    -- so caterings that only sell e.g. 10-day plans still surface (otherwise
    -- ~80% of Wrocław caterings would vanish on the default 5-day request).
    -- Pick the genuinely cheapest captured price per (catering, dc_id).
    --
    -- Important data-model facts that shape this CTE:
    --   1) diet_calories_id is NOT globally unique — dedup must include
    --      company_id, otherwise catering A's price shadows catering B's.
    --   2) Dietly's API returns the promo discount as a separate
    --      total_promo_code_discount line and leaves per_day_cost_with_discounts
    --      at the pre-promo value. The truthful effective per-day is
    --      total_cost / order_days (totalCostToPay is already net of every
    --      discount the API applied).
    --   3) Promo and order-length discounts don't stack at checkout — dietly
    --      picks whichever is bigger. So we just need the row with the
    --      smallest effective per-day, regardless of which mechanism produced it.
    --   4) Only count rows whose applied codes are still ACTIVE today — an
    --      expired-promo capture is misleading once the code stops working.
    priced AS (
      SELECT DISTINCT ON (p.company_id, p.diet_calories_id)
        p.diet_calories_id,
        p.company_id,
        p.order_days,
        (p.total_cost::numeric / NULLIF(p.order_days, 0))   AS price_per_day,
        p.per_day_cost                                       AS price_per_day_list,
        COALESCE(p.promo_codes, ARRAY[]::text[])             AS applied_promo_codes,
        COALESCE(p.total_promo_code_discount, 0)             AS promo_discount_total
      FROM prices p
      WHERE p.city_id  = $1
        AND p.total_cost IS NOT NULL
        AND p.order_days > 0
        AND (
          COALESCE(array_length(p.promo_codes, 1), 0) = 0
          OR EXISTS (
            SELECT 1
            FROM campaigns c
            WHERE c.company_id = p.company_id
              AND c.code = ANY (p.promo_codes)
              AND c.is_active
              AND (c.starts_at IS NULL OR c.starts_at <= CURRENT_DATE)
              AND (c.ends_at   IS NULL OR c.ends_at   >= CURRENT_DATE)
          )
        )
      ORDER BY p.company_id, p.diet_calories_id,
               (p.total_cost::numeric / NULLIF(p.order_days, 0)) ASC,
               -- Tiebreak on equal effective per-day: prefer the requested
               -- order-days duration so the displayed plan matches the user's
               -- intent when two plan lengths net out to the same per-day price.
               (p.order_days = $5::int) DESC,
               p.captured_at DESC
    ),
    priced_promos AS (
      SELECT
        pr.diet_calories_id,
        pr.company_id,
        pr.price_per_day,
        CASE
          WHEN pr.price_per_day_list IS NOT NULL
           AND pr.price_per_day IS NOT NULL
           AND pr.price_per_day_list <> pr.price_per_day
          THEN pr.price_per_day_list
          ELSE NULL
        END AS price_per_day_before_promo,
        COALESCE(
          (
            -- One row per applied code, picking the biggest discount among
            -- date-current, active campaigns for this catering. Per-company
            -- rows win over global (company_id IS NULL) ones via the ORDER BY.
            SELECT jsonb_agg(promo ORDER BY code)
            FROM (
              SELECT DISTINCT ON (c.code)
                c.code,
                jsonb_build_object(
                  'code',             c.code,
                  'discount_percent', c.discount_percent,
                  'ends_at',          to_char(c.ends_at, 'YYYY-MM-DD')
                ) AS promo
              FROM campaigns c
              WHERE c.code = ANY (pr.applied_promo_codes)
                AND c.is_active
                AND (c.company_id IS NULL OR c.company_id = pr.company_id)
                AND (c.starts_at IS NULL OR c.starts_at <= CURRENT_DATE)
                AND (c.ends_at   IS NULL OR c.ends_at   >= CURRENT_DATE)
              ORDER BY c.code,
                       (c.company_id = pr.company_id) DESC NULLS LAST,
                       c.discount_percent DESC NULLS LAST,
                       c.last_seen_at DESC NULLS LAST
            ) deduped
          ),
          '[]'::jsonb
        ) AS promos_json
      FROM priced pr
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
        co.logo_url                                         AS company_logo_url,
        d.name                                              AS diet_name,
        d.diet_tag                                          AS diet_tag,
        t.name                                              AS tier_name,
        d.is_menu_configuration                             AS is_menu_configuration,
        dc.calories                                         AS calories,
        prp.price_per_day::text                             AS price_per_day,
        prp.price_per_day_before_promo::text                AS price_per_day_before_promo,
        prp.promos_json::text                               AS promos_json,
        po.score_best::text                                 AS score_best,
        po.score_default::text                              AS score_default,
        po.n_slots                                          AS n_slots,
        po.picks_json::text                                 AS picks_json,
        po.picks_default_json::text                         AS picks_default_json,
        COUNT(*) OVER ()::int                               AS considered_count
      FROM per_offer po
      -- diet_calories_id is NOT globally unique — caterings reuse small
      -- per-company ids that collide across companies. Joining only on
      -- diet_calories_id silently picks the wrong company's row, propagating
      -- the wrong calories, diet name, and company through every downstream
      -- join. Always pin by company_id.
      JOIN diet_calories dc
        ON dc.diet_calories_id = po.diet_calories_id
       AND dc.company_id       = po.company_id
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
      -- INNER JOIN: drop offers without a recent price for the requested
      -- order_days. Otherwise the UI lists caterings at "0 zł" — caterings
      -- that only sell 10/20-day packages would all show up at the bottom.
      -- The company_id match is critical: diet_calories_id is not globally
      -- unique, so without it we'd pair an offer with another catering's price.
      JOIN priced_promos prp
        ON prp.diet_calories_id = po.diet_calories_id
       AND prp.company_id       = po.company_id
       AND prp.price_per_day IS NOT NULL
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

    // Alternates only matter for menu-config offers — for fixed offers each
    // slot has a single option so the swap popover is meaningless.
    const picks = decodePicks(r.picks_json, 1, isMC);
    const picksDefault = decodePicks(r.picks_default_json, 1, isMC);
    const promos = decodePromos(r.promos_json);
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
      company: {
        id: r.company_id,
        logo_url: r.company_logo_url,
        name: r.company_name,
      },
      diet: { name: r.diet_name, tag: r.diet_tag },
      is_menu_configuration: isMC,
      offer_id,
      picks,
      picks_default: picksDefaultOut,
      price_per_day:
        r.price_per_day === null ? null : Number.parseFloat(r.price_per_day),
      price_per_day_before_promo:
        r.price_per_day_before_promo === null
          ? null
          : Number.parseFloat(r.price_per_day_before_promo),
      promos,
      tier: r.tier_name === null ? null : { name: r.tier_name },
      verdict,
    };
    return out;
  });

  return { considered_count: consideredCount, offers };
};

// ── 9. Week view ───────────────────────────────────────────────────────────
// Per-date list of every ranked offer (no top-N slice — the home page's
// scatter wants the genuine full pool so "top 5 by price" stays honest).

interface DateRow {
  readonly menu_date: Date;
}

// `pg` parses DATE columns into JS Date using the process's LOCAL timezone
// (the value `2026-05-22` becomes `2026-05-22T00:00 local time`), so we must
// extract Y-M-D with the local getters — `getUTC*` would shift the date back
// by a day whenever the process runs in any timezone east of UTC.
const formatIsoDate = (d: Readonly<Date>): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

export interface WeekViewDay {
  /** ISO yyyy-mm-dd. */
  readonly date: string;
  readonly all_offers: readonly RankedDayOffer[];
  readonly total_considered: number;
}

/**
 * Resolve the next N consecutive dates that actually have menu data for this
 * city. Result is sorted ascending; never returns more than `maxDays`.
 */
export const getAvailableDates = async (
  cityId: number,
  fromDate: string,
  maxDays: number
): Promise<string[]> => {
  const rows = await query<DateRow>(
    `SELECT DISTINCT menu_date
     FROM current_daily_menu
     WHERE city_id = $1
       AND menu_date >= $2::date
     ORDER BY menu_date ASC
     LIMIT $3`,
    [cityId, fromDate, maxDays]
  );
  return rows.map(({ menu_date }: { readonly menu_date: Readonly<Date> }) =>
    formatIsoDate(menu_date)
  );
};

export const getWeekView = async (
  args: Readonly<{
    cityId: number;
    dates: readonly string[];
    prefer: readonly string[];
    avoid: readonly string[];
    kcalMin?: number;
    kcalMax?: number;
    orderDays?: number;
    weights?: { readonly prefer?: number; readonly avoid?: number };
  }>
): Promise<WeekViewDay[]> => {
  interface DayResult {
    readonly offers: readonly RankedDayOffer[];
    readonly considered_count: number;
  }
  const empty: DayResult = { considered_count: 0, offers: [] };
  const dayResults: DayResult[] = Array.from(
    { length: args.dates.length },
    () => empty
  );
  // 0 = no limit. Required for honest top-5-by-any-axis scatter.
  await Promise.all(
    args.dates.map(async (d, idx) => {
      const r = await getRankedOffersForDay({
        avoid: args.avoid,
        cityId: args.cityId,
        date: d,
        kcalMax: args.kcalMax,
        kcalMin: args.kcalMin,
        limit: 0,
        orderDays: args.orderDays,
        prefer: args.prefer,
        weights: args.weights,
      });
      dayResults[idx] = r;
    })
  );
  return args.dates.map((date, i) => ({
    all_offers: dayResults[i]?.offers ?? [],
    date,
    total_considered: dayResults[i]?.considered_count ?? 0,
  }));
};

// ── 10. Weekly plan ─────────────────────────────────────────────────────────
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
  // Effective per-day = total_cost / order_days (net of every discount the
  // API applied; see commentary on the `priced` CTE in getRankedOffersForDay).
  // diet_calories_id is not globally unique — must filter by company_id too.
  const priceRows = await query<BundlePriceRow>(
    `SELECT DISTINCT ON (company_id, diet_calories_id)
        (total_cost::numeric / NULLIF(order_days, 0))::text AS per_day,
        per_day_cost::text                                   AS without_discounts
     FROM prices
     WHERE city_id          = $1
       AND diet_calories_id = $2
       AND company_id       = $4
       AND order_days       = $3
       AND total_cost       IS NOT NULL
     ORDER BY company_id, diet_calories_id, captured_at DESC`,
    [cityId, dc, days.length, top.id]
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
        (total_cost::numeric / NULLIF(order_days, 0)) AS price,
        promo_codes
      FROM prices
      WHERE company_id = $1
        AND diet_calories_id = $2
        AND city_id = $3
        AND order_days = $4
        AND total_cost IS NOT NULL
      ORDER BY date_trunc('day', captured_at),
               (total_cost::numeric / NULLIF(order_days, 0)) ASC,
               captured_at DESC, id DESC
    ) t
    ORDER BY day ASC
    `,
    [companyId, dietCaloriesId, cityId, days]
  );
  return rows;
};
