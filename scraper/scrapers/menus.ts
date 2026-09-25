// Daily-menu scraper.
//
// For each company we walk the *canonical* leaf set of the catalog —
// one diet_calories row per (tier_id, diet_option_id) group, picking the
// lowest kcal entry. Different kcal levels of the same option share the same
// dish lineup (only portion sizes differ — verified), so this dedupes ~7×
// without losing any dish-level detail.
//
// For each (target, date) we hit
//   GET /company-card/{companyId}/menu/{dietCaloriesId}/city/{cityId}/date/{D}
// (optionally ?tierId=...) and persist into:
//   - meals             dish identity per (company, name).
//   - meal_variants     the dish's content as served (label, thermo,
//                       allergens, ingredients), content-addressed: a
//                       content seen before reuses its row.
//   - meal_ingredients  structured ingredients, written once per new variant.
//   - menu_items        one span per menu option; identical re-observations
//                       extend it, anything else closes it (see "History
//                       model" in db/schema.sql). Portion macros live here.
//                       National: no city in the key (v15). The URL still
//                       names a city because the API requires one; menus
//                       were identical across every city compared, so which
//                       one doesn't change what is stored.
//
// At end of run, every newly inserted variant gets embedded via
// scraper/embed-queue.ts; index.ts flushes them.

import {
  get,
  parseInfoMacros,
  parseKcalNumber,
  parseGrams,
  nextNDates,
  HttpError,
} from "../api";
import { q, withTx } from "../db";
import { enqueueVariantForEmbedding } from "../embed-queue";
import { SPAN_GAP_SQL } from "../spans";
import type {
  DeepReadonly,
  MealDetails,
  MealOption,
  MealSlot,
  MenuResponse,
} from "../types";

const MAX_PARALLEL_FETCHES = 8;
const DEFAULT_MENU_DAYS = 7;

// ── target selection ─────────────────────────────────────────────────────────

interface MenuTarget {
  diet_calories_id: number;
  tier_id: number | null;
  is_menu_configuration: boolean;
}

interface CompanyMenuConfig {
  menu_enabled: boolean;
  menu_days_ahead: number;
  /**
   * Dietly's per-catering switches. When false, dietly's own clients hide
   * nutrition / ingredients panels even though the API returns a body. We
   * mirror that behavior: write null kcal+macros / null ingredients_raw.
   * Some caterings with these set to false also return a poisoned placeholder
   * body (kcal=1063 leczo for urbanfits, kcal=44 kakao for przelomwodzywianiu,
   * etc.) — honoring the flag is the cleanest way to avoid storing the lie.
   */
  nutrition_visible: boolean;
  ingredients_visible: boolean;
}

const errMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const loadCompanyConfig = async (
  companyId: string
): Promise<CompanyMenuConfig | null> => {
  const res = await q<{
    menu_enabled: boolean | null;
    menu_days_ahead: number | null;
    nutrition_visible: boolean | null;
    ingredients_visible: boolean | null;
  }>(
    `SELECT menu_enabled, menu_days_ahead, nutrition_visible, ingredients_visible
       FROM companies WHERE company_id = $1`,
    [companyId]
  );
  if (res.rowCount === 0) {
    return null;
  }
  const [row] = res.rows;
  return {
    ingredients_visible: row.ingredients_visible !== false,
    menu_days_ahead: row.menu_days_ahead ?? DEFAULT_MENU_DAYS,
    menu_enabled: row.menu_enabled !== false,
    nutrition_visible: row.nutrition_visible !== false,
  };
};

/**
 * One canonical (tier, option) representative per company. For each group we
 * pick the row with MIN(calories) — stable choice; same dish lineup as any
 * sibling kcal level. Ready diets (synthetic tier=0/option=0) collapse into
 * a single representative per (company, diet) — also fine.
 */
const loadMenuTargets = async (companyId: string): Promise<MenuTarget[]> => {
  const res = await q<{
    diet_calories_id: number;
    tier_id: number | null;
    is_menu_configuration: boolean | null;
  }>(
    `WITH ranked AS (
       SELECT
         dc.diet_calories_id,
         dc.tier_id,
         d.is_menu_configuration,
         ROW_NUMBER() OVER (
           PARTITION BY dc.company_id, dc.tier_id, dc.diet_option_id, dc.diet_id
           ORDER BY dc.calories NULLS LAST, dc.diet_calories_id
         ) AS rn
       FROM diet_calories dc
       JOIN diets d
         ON d.diet_id = dc.diet_id AND d.company_id = dc.company_id
       WHERE dc.company_id = $1
         AND dc.is_active = TRUE
         AND d.is_active = TRUE
     )
     SELECT diet_calories_id, tier_id, is_menu_configuration
     FROM ranked
     WHERE rn = 1
     ORDER BY tier_id NULLS FIRST, diet_calories_id`,
    [companyId]
  );
  return res.rows.map(
    (
      r: Readonly<{
        diet_calories_id: number;
        tier_id: number | null;
        is_menu_configuration: boolean | null;
      }>
    ) => ({
      diet_calories_id: r.diet_calories_id,
      is_menu_configuration: r.is_menu_configuration ?? false,
      tier_id: r.tier_id,
    })
  );
};

// ── ingredient parsing + normalization ───────────────────────────────────────

export interface IngredientRow {
  position: number;
  name_raw: string;
  name_normalized: string;
  is_major: boolean;
  /** dietly's dietaryExclusionIds for this ingredient (its "wyklucz" vocabulary) */
  exclusion_ids: number[];
}

/** One allergen as served: dietly's id plus both wordings. */
export interface AllergenDetail {
  id: number | null;
  company_name: string;
  dietly_name: string;
}

// Polish-to-ASCII fold for normalized lookups. Done in JS to keep DB indexes
// simple (gin_trgm on normalized text doesn't need ICU collation).
const POLISH_FOLD: Readonly<Record<string, string>> = {
  ó: "o",
  ą: "a",
  ć: "c",
  ę: "e",
  ł: "l",
  ń: "n",
  ś: "s",
  ź: "z",
  ż: "z",
};

const normalizeIngredient = (raw: string): string => {
  const s = raw.toLowerCase();
  let out = "";
  for (const ch of s) {
    out += POLISH_FOLD[ch] ?? ch;
  }
  // Collapse whitespace and trim.
  return out.replaceAll(/\s+/gu, " ").trim();
};

const parseStructuredIngredients = (
  details: DeepReadonly<MealDetails> | undefined
): IngredientRow[] => {
  const raw = details?.ingredients ?? [];
  const out: IngredientRow[] = [];
  let pos = 1;
  for (const item of raw) {
    const nameRaw = item.name.trim();
    if (nameRaw === "") {
      continue;
    }
    out.push({
      exclusion_ids: (item.exclusion ?? []).map((e) => e.dietaryExclusionId),
      is_major: item.major,
      name_normalized: normalizeIngredient(nameRaw),
      name_raw: nameRaw,
      position: pos,
    });
    pos += 1;
  }
  return out;
};

// ── meal field extraction ─────────────────────────────────────────────────────

export interface MealFields {
  api_meal_slot_id: number;
  name: string | null;
  label: string | null;
  thermo: string | null;
  kcal: number | null;
  protein_g: number | null;
  fat_g: number | null;
  carbs_g: number | null;
  fiber_g: number | null;
  sugar_g: number | null;
  saturated_fat_g: number | null;
  salt_g: number | null;
  image_url: string | null;
  reviews_score: number | null;
  reviews_number: number | null;
  allergens: string[];
  allergens_detail: AllergenDetail[];
  ingredients_raw: string | null;
  ingredients: IngredientRow[];
  /** [dietaryExclusionId, name] pairs, for the dietary_exclusions dictionary */
  exclusions: readonly (readonly [number, string])[];
}

const extractAllergens = (
  details: DeepReadonly<MealDetails> | undefined
): string[] => {
  const raw = details?.allergensWithExcluded ?? [];
  const seen = new Set<string>();
  for (const a of raw) {
    const name = a.dietlyAllergenName.trim();
    if (name !== "") {
      seen.add(name);
    }
  }
  return [...seen].toSorted();
};

const extractAllergensDetail = (
  details: DeepReadonly<MealDetails> | undefined
): AllergenDetail[] =>
  (details?.allergensWithExcluded ?? []).map((a) => ({
    company_name: a.companyAllergenName,
    dietly_name: a.dietlyAllergenName,
    id: a.dietaryExclusionId ?? null,
  }));

/** dietly's exclusion vocabulary seen in one option, as [id, name] pairs. */
const exclusionsOf = (
  details: DeepReadonly<MealDetails> | undefined
): [number, string][] => {
  const out = new Map<number, string>();
  for (const i of details?.ingredients ?? []) {
    for (const e of i.exclusion ?? []) {
      out.set(e.dietaryExclusionId, e.name);
    }
  }
  for (const a of details?.allergensWithExcluded ?? []) {
    if (a.dietaryExclusionId !== null && !out.has(a.dietaryExclusionId)) {
      out.set(a.dietaryExclusionId, a.dietlyAllergenName);
    }
  }
  return [...out];
};

const extractIngredientsRaw = (
  details: DeepReadonly<MealDetails> | undefined
): string | null => {
  const raw = details?.ingredients ?? [];
  const parts: string[] = [];
  for (const i of raw) {
    const n = i.name.trim();
    if (n !== "") {
      parts.push(n);
    }
  }
  return parts.length > 0 ? parts.join("; ") : null;
};

interface ParsedMacros {
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
}

const parseMacros = (
  details: DeepReadonly<MealDetails> | undefined,
  info: string | null
): ParsedMacros => {
  const fromDetails = {
    carbs_g: parseGrams(details?.carbohydrate),
    fat_g: parseGrams(details?.fat),
    kcal: parseKcalNumber(details?.calories),
    protein_g: parseGrams(details?.protein),
  };
  const fromInfo = parseInfoMacros(info);
  return {
    carbs_g: fromDetails.carbs_g ?? fromInfo.carbs_g,
    fat_g: fromDetails.fat_g ?? fromInfo.fat_g,
    kcal: fromDetails.kcal ?? fromInfo.kcal,
    protein_g: fromDetails.protein_g ?? fromInfo.protein_g,
  };
};

interface BodyVisibility {
  nutrition_visible: boolean;
  ingredients_visible: boolean;
}

// oxlint-disable-next-line eslint/complexity -- linear ternary fan-out; each branch is a single field gate on the visibility flag, splitting only hides the symmetry
const mealFieldsFromOption = (
  option: DeepReadonly<MealOption>,
  vis: Readonly<BodyVisibility>
): MealFields => {
  const { details } = option;
  const name = option.name ?? details?.name ?? null;
  const reviews_number = option.reviewsNumber ?? null;
  const reviews_score = option.reviewsScore ?? null;
  const label = option.label ?? null;
  const thermo = option.thermo ?? details?.thermo ?? null;

  // Honor dietly's per-catering visibility flags: if dietly's own UI doesn't
  // show nutrition / ingredients for this catering, neither do we. Some
  // caterings with these flags off also return a uniform placeholder body
  // (the "leczo bug"); skipping the body write is the cleanest defense.
  const parsedMacros = parseMacros(details, option.info);
  const macros = vis.nutrition_visible
    ? parsedMacros
    : { carbs_g: null, fat_g: null, kcal: null, protein_g: null };
  const fiber_g = vis.nutrition_visible
    ? parseGrams(details?.dietaryFiber)
    : null;
  const sugar_g = vis.nutrition_visible ? parseGrams(details?.sugar) : null;
  const saturated_fat_g = vis.nutrition_visible
    ? parseGrams(details?.saturatedFattyAcids)
    : null;
  const salt_g = vis.nutrition_visible ? parseGrams(details?.salt) : null;

  const ingredients_raw = vis.ingredients_visible
    ? extractIngredientsRaw(details)
    : null;
  const allergens = vis.ingredients_visible ? extractAllergens(details) : [];
  const allergensDetail = vis.ingredients_visible
    ? extractAllergensDetail(details)
    : [];
  const exclusions = vis.ingredients_visible ? exclusionsOf(details) : [];
  // dietly sends "" for a missing photo; store that as unknown.
  const image = details?.imageUrl ?? "";
  const ingredients = vis.ingredients_visible
    ? parseStructuredIngredients(details)
    : [];

  return {
    allergens,
    allergens_detail: allergensDetail,
    api_meal_slot_id: option.dietCaloriesMealId,
    carbs_g: macros.carbs_g,
    exclusions,
    fat_g: macros.fat_g,
    fiber_g,
    image_url: image === "" ? null : image,
    ingredients,
    ingredients_raw,
    kcal: macros.kcal,
    label,
    name,
    protein_g: macros.protein_g,
    reviews_number,
    reviews_score,
    salt_g,
    saturated_fat_g,
    sugar_g,
    thermo,
  };
};

// ── DB writes ─────────────────────────────────────────────────────────────────

/** Upsert the dish identity, keyed by (company_id, name). */
export const upsertMeal = async (
  companyId: string,
  name: string,
  imageUrl: string | null
): Promise<number | null> => {
  const res = await q<{ id: string }>(
    `INSERT INTO meals (company_id, name, image_url)
     VALUES ($1, $2, $3)
     ON CONFLICT (company_id, name) DO UPDATE SET
       last_seen_at = NOW(),
       image_url    = COALESCE(EXCLUDED.image_url, meals.image_url)
     RETURNING id`,
    [companyId, name, imageUrl]
  );
  const [row] = res.rows;
  return row === undefined ? null : Number(row.id);
};

/**
 * Upsert the served content as a variant of `mealId`. The hash is computed
 * by meal_content_sha() in the database so it matches the v11 backfill.
 *
 * Content seen before (the common case) is one UPDATE. A new variant is
 * written in one transaction together with its ingredient list — names go
 * through the ingredient_names dictionary, exclusion ids through
 * dietary_exclusions — so a variant never exists without its ingredients.
 */
export const upsertVariant = async (
  mealId: number,
  m: DeepReadonly<MealFields>
): Promise<{ variant_id: number; inserted: boolean } | null> => {
  const ingredientsJson = JSON.stringify(m.ingredients);
  const shaArgs = [m.label, m.thermo, m.allergens, ingredientsJson];
  const seen = await q<{ id: string }>(
    `UPDATE meal_variants SET last_seen_at = NOW()
      WHERE meal_id = $1
        AND content_sha = meal_content_sha($2::text, $3::text, $4::text[], $5::jsonb)
      RETURNING id`,
    [mealId, ...shaArgs]
  );
  const [existing] = seen.rows;
  if (existing !== undefined) {
    return { inserted: false, variant_id: Number(existing.id) };
  }
  return withTx(async (tq) => {
    const res = await tq<{ id: string; inserted: boolean }>(
      `INSERT INTO meal_variants
         (meal_id, content_sha, label, thermo, allergens, ingredients_raw,
          allergens_detail)
       VALUES ($1, meal_content_sha($2::text, $3::text, $4::text[], $5::jsonb),
               $2, $3, $4::text[], $6, $7::jsonb)
       ON CONFLICT (meal_id, content_sha) DO UPDATE SET last_seen_at = NOW()
       RETURNING id, (xmax = 0) AS inserted`,
      [
        mealId,
        ...shaArgs,
        m.ingredients_raw,
        JSON.stringify(m.allergens_detail),
      ]
    );
    const [row] = res.rows;
    if (row === undefined) {
      return null;
    }
    const variantId = Number(row.id);
    if (!row.inserted) {
      return { inserted: false, variant_id: variantId };
    }
    if (m.exclusions.length > 0) {
      await tq(
        `INSERT INTO dietary_exclusions (exclusion_id, name)
         SELECT * FROM unnest($1::int[], $2::text[])
         ON CONFLICT (exclusion_id) DO NOTHING`,
        [m.exclusions.map(([id]) => id), m.exclusions.map(([, name]) => name)]
      );
    }
    if (m.ingredients.length > 0) {
      await tq(
        `INSERT INTO ingredient_names (name_raw, name_normalized)
         SELECT e->>'name_raw', e->>'name_normalized'
         FROM jsonb_array_elements($1::jsonb) e
         ON CONFLICT (name_raw) DO NOTHING`,
        [ingredientsJson]
      );
      await tq(
        `INSERT INTO variant_ingredients
           (variant_id, position, name_id, is_major, exclusion_ids)
         SELECT $1, (e->>'position')::int, n.id, (e->>'is_major')::boolean,
                ARRAY(SELECT jsonb_array_elements_text(e->'exclusion_ids'))::int[]
         FROM jsonb_array_elements($2::jsonb) e
         JOIN ingredient_names n ON n.name_raw = e->>'name_raw'`,
        [variantId, ingredientsJson]
      );
    }
    return { inserted: true, variant_id: variantId };
  });
};

/** One option as observed in one menu fetch. */
export interface MenuObservation {
  api_meal_slot_id: number;
  slot_name: string;
  meal_id: number;
  variant_id: number | null;
  is_default: boolean;
  kcal: number | null;
  protein_g: number | null;
  fat_g: number | null;
  carbs_g: number | null;
  fiber_g: number | null;
  sugar_g: number | null;
  saturated_fat_g: number | null;
  salt_g: number | null;
  reviews_score: number | null;
  reviews_number: number | null;
  image_url: string | null;
}

// Value columns of a menu option and the SQL type each is stored as, in
// unnest() order after the key column api_meal_slot_id ($5).
const OPTION_COLUMNS = [
  ["slot_name", "varchar(80)"],
  ["meal_id", "bigint"],
  ["variant_id", "bigint"],
  ["is_default", "boolean"],
  ["kcal", "numeric(7,2)"],
  ["protein_g", "numeric(7,2)"],
  ["fat_g", "numeric(7,2)"],
  ["carbs_g", "numeric(7,2)"],
  ["fiber_g", "numeric(7,2)"],
  ["sugar_g", "numeric(7,2)"],
  ["saturated_fat_g", "numeric(7,2)"],
  ["salt_g", "numeric(7,2)"],
  ["reviews_score", "numeric(5,2)"],
  ["reviews_number", "int"],
  ["image_url", "text"],
] as const satisfies readonly (readonly [keyof MenuObservation, string])[];

const OPTION_NAMES = OPTION_COLUMNS.map(([name]) => name).join(", ");
// unnest() over one array per column. Arrays are bound as their base type;
// each value is cast to the column type where it is compared or stored, so
// a comparison sees exactly what an INSERT would keep.
const OBS_CTE = `obs AS (
  SELECT * FROM unnest($5::bigint[], ${OPTION_COLUMNS.map(
    ([, type], i) => `$${i + 6}::${type.replace(/\(.*\)/u, "")}[]`
  ).join(", ")}) AS o(api_meal_slot_id, ${OPTION_NAMES})
)`;
const OBS_VALUES = OPTION_COLUMNS.map(
  ([name, type]) => `o.${name}::${type}`
).join(", ");

const SCOPE_MATCH = `mi.company_id = $1
  AND mi.diet_calories_id = $2 AND mi.tier_id = $3 AND mi.menu_date = $4
  AND mi.closed_at IS NULL`;

/** One fetched menu: (company, diet_calories_id, tier_id, date). */
export type MenuScope = readonly [string, number, number, string];

/**
 * Record one successful menu fetch as spans, atomically:
 *   1. open spans re-observed with identical values within SPAN_GAP are
 *      extended;
 *   2. every other open span of this menu is closed — its values changed,
 *      it went stale, or the option is gone from the menu;
 *   3. options not extended in (1) open new spans.
 * Serialised per menu with an advisory lock. An empty observation list is a
 * no-op: it says nothing about what was removed.
 */
export const recordMenu = async (
  scope: MenuScope,
  observations: readonly Readonly<MenuObservation>[]
): Promise<void> => {
  if (observations.length === 0) {
    return;
  }
  const params: unknown[] = [
    ...scope,
    observations.map((o) => o.api_meal_slot_id),
    ...OPTION_COLUMNS.map(([name]) => observations.map((o) => o[name])),
  ];
  await withTx(async (tq) => {
    await tq("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `menu:${scope.join(":")}`,
    ]);
    const kept = await tq<{ api_meal_slot_id: string }>(
      `WITH ${OBS_CTE}
       UPDATE menu_items mi
          SET last_seen_at = NOW(), observations = mi.observations + 1
         FROM obs o
        WHERE ${SCOPE_MATCH}
          AND mi.api_meal_slot_id = o.api_meal_slot_id
          AND mi.last_seen_at >= NOW() - ${SPAN_GAP_SQL}
          AND ROW(${OPTION_COLUMNS.map(([name]) => `mi.${name}`).join(", ")})
              IS NOT DISTINCT FROM ROW(${OBS_VALUES})
       RETURNING mi.api_meal_slot_id`,
      params
    );
    const keptIds = kept.rows.map((r: Readonly<{ api_meal_slot_id: string }>) =>
      Number(r.api_meal_slot_id)
    );
    await tq(
      `UPDATE menu_items mi SET closed_at = NOW()
        WHERE ${SCOPE_MATCH}
          AND mi.api_meal_slot_id <> ALL ($5::bigint[])`,
      [...scope, keptIds]
    );
    await tq(
      `WITH ${OBS_CTE}
       INSERT INTO menu_items
         (company_id, diet_calories_id, tier_id, menu_date,
          api_meal_slot_id, ${OPTION_NAMES})
       SELECT $1, $2, $3, $4::date, o.api_meal_slot_id, ${OBS_VALUES}
         FROM obs o
        WHERE o.api_meal_slot_id <> ALL ($${OPTION_COLUMNS.length + 6}::bigint[])`,
      [...params, keptIds]
    );
  });
};

// ── per-fetch processor ───────────────────────────────────────────────────────

interface FetchResult {
  variantsNew: number;
  options: number;
  fetched: boolean;
  errored?: boolean;
}

/**
 * Upsert one option's dish and variant and build its observation. Returns
 * null for options without a usable dish name.
 */
const observeOption = async (
  companyId: string,
  slot: DeepReadonly<MealSlot>,
  option: DeepReadonly<MealOption>,
  vis: Readonly<BodyVisibility>
): Promise<{ observation: MenuObservation; newVariant: boolean } | null> => {
  const fields = mealFieldsFromOption(option, vis);
  const name = fields.name?.trim() ?? "";
  if (name === "") {
    return null;
  }
  const mealId = await upsertMeal(companyId, name, fields.image_url);
  if (mealId === null) {
    return null;
  }
  const variant = await upsertVariant(mealId, fields);
  const newVariant = variant?.inserted === true;
  if (newVariant) {
    enqueueVariantForEmbedding(variant.variant_id);
  }
  return {
    newVariant,
    observation: {
      api_meal_slot_id: option.dietCaloriesMealId,
      carbs_g: fields.carbs_g,
      fat_g: fields.fat_g,
      fiber_g: fields.fiber_g,
      image_url: fields.image_url,
      is_default: slot.baseDietCaloriesMealId === option.dietCaloriesMealId,
      kcal: fields.kcal,
      meal_id: mealId,
      protein_g: fields.protein_g,
      reviews_number: fields.reviews_number,
      reviews_score: fields.reviews_score,
      salt_g: fields.salt_g,
      saturated_fat_g: fields.saturated_fat_g,
      slot_name: slot.name ?? "",
      sugar_g: fields.sugar_g,
      variant_id: variant?.variant_id ?? null,
    },
  };
};

const processOneMenu = async (
  companyId: string,
  cityId: number,
  target: Readonly<MenuTarget>,
  date: string,
  vis: Readonly<BodyVisibility>
): Promise<FetchResult> => {
  const tierQs =
    target.is_menu_configuration && target.tier_id !== null
      ? `?tierId=${target.tier_id}`
      : "";
  const path = `/api/mobile/open/company-card/${companyId}/menu/${target.diet_calories_id}/city/${cityId}/date/${date}${tierQs}`;

  let response: MenuResponse;
  try {
    response = await get<MenuResponse>(path, { companyId });
  } catch (error) {
    if (
      error instanceof HttpError &&
      (error.status === 404 || error.status === 400)
    ) {
      console.warn(
        `[menus] ${companyId} ${target.diet_calories_id} @ ${date}: ${error.status}`
      );
      return { fetched: false, options: 0, variantsNew: 0 };
    }
    throw error;
  }

  // oxlint-disable-next-line eqeqeq -- intentional == for null/undefined; cf-fetch may yield undefined on transport error
  if (response == null || !Array.isArray(response.meals)) {
    return { fetched: true, options: 0, variantsNew: 0 };
  }

  const observations = new Map<number, MenuObservation>();
  let variantsNew = 0;

  for (const slot of response.meals) {
    if (!Array.isArray(slot.options)) {
      continue;
    }
    for (const option of slot.options) {
      // dietCaloriesMealId is unique within a menu response; keep the
      // first if the API ever repeats one.
      // oxlint-disable-next-line eqeqeq -- intentional == for null/undefined
      if (
        option.dietCaloriesMealId == null ||
        observations.has(option.dietCaloriesMealId)
      ) {
        continue;
      }
      const observed = await observeOption(companyId, slot, option, vis);
      if (observed === null) {
        continue;
      }
      if (observed.newVariant) {
        variantsNew += 1;
      }
      observations.set(option.dietCaloriesMealId, observed.observation);
    }
  }

  // An empty menu carries no information about what was removed — dietly
  // returns one for dates it hasn't published yet — so recordMenu ignores it.
  await recordMenu(
    [companyId, target.diet_calories_id, target.tier_id ?? 0, date],
    [...observations.values()]
  );

  return { fetched: true, options: observations.size, variantsNew };
};

// ── concurrency cap ──────────────────────────────────────────────────────────

const runWithCap = async <T, R>(
  items: readonly T[],
  cap: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> => {
  const results: R[] = Array.from({ length: items.length });
  let cursor = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(cap, items.length)) },
    async () => {
      while (true) {
        const idx = cursor;
        cursor += 1;
        if (idx >= items.length) {
          return;
        }
        results[idx] = await fn(items[idx]);
      }
    }
  );
  await Promise.all(workers);
  return results;
};

// ── main export ───────────────────────────────────────────────────────────────

export const scrapeMenus = async (
  companyId: string,
  cityId: number
): Promise<{ errors: number }> => {
  const t0 = Date.now();

  const cfg = await loadCompanyConfig(companyId);
  if (cfg === null) {
    console.warn(
      `[menus] ${companyId}: no companies row, skipping (run catalog first)`
    );
    return { errors: 0 };
  }
  if (!cfg.menu_enabled) {
    console.log(`[menus] ${companyId}: menu disabled, skipping`);
    return { errors: 0 };
  }

  const envCap =
    process.env.MENU_DAYS !== undefined && process.env.MENU_DAYS !== ""
      ? Number(process.env.MENU_DAYS)
      : DEFAULT_MENU_DAYS;
  const days = Math.max(
    1,
    Math.min(cfg.menu_days_ahead || DEFAULT_MENU_DAYS, envCap)
  );
  const dates = nextNDates(days, 0);

  const targets = await loadMenuTargets(companyId);
  if (targets.length === 0) {
    console.warn(
      `[menus] ${companyId}: no live diet_calories targets, skipping`
    );
    return { errors: 0 };
  }

  const totalCalls = targets.length * dates.length;
  const visTag =
    cfg.nutrition_visible && cfg.ingredients_visible
      ? ""
      : ` [body-hidden: nutrition=${cfg.nutrition_visible} ingredients=${cfg.ingredients_visible}]`;
  console.log(
    `[menus] ${companyId} / city=${cityId} → ${targets.length} targets × ${dates.length} days = ${totalCalls} calls${visTag}`
  );

  const vis: BodyVisibility = {
    ingredients_visible: cfg.ingredients_visible,
    nutrition_visible: cfg.nutrition_visible,
  };

  const work: { target: MenuTarget; date: string }[] = [];
  for (const target of targets) {
    for (const date of dates) {
      work.push({ date, target });
    }
  }

  let totalVariants = 0;
  let totalOptions = 0;
  let totalFetched = 0;
  let totalErrors = 0;

  const results = await runWithCap(
    work,
    MAX_PARALLEL_FETCHES,
    async ({
      target,
      date,
    }: DeepReadonly<{ target: MenuTarget; date: string }>) => {
      try {
        return await processOneMenu(companyId, cityId, target, date, vis);
      } catch (error) {
        console.warn(
          `[menus] ${companyId} dc=${target.diet_calories_id} tier=${target.tier_id ?? "-"} @ ${date}: ${errMessage(error)}`
        );
        return {
          errored: true,
          fetched: false,
          options: 0,
          variantsNew: 0,
        };
      }
    }
  );

  for (const r of results) {
    totalVariants += r.variantsNew;
    totalOptions += r.options;
    if (r.fetched) {
      totalFetched += 1;
    }
    if (r.errored === true) {
      totalErrors += 1;
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const errSuffix = totalErrors > 0 ? `, ${totalErrors} errors` : "";
  console.log(
    `[menus] ✓ ${companyId}: ${totalOptions} options recorded, ${totalVariants} new variants, ${totalFetched}/${totalCalls} calls fetched${errSuffix} (${elapsed}s)`
  );
  return { errors: totalErrors };
};
