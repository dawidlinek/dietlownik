// Daily-menu scraper.
//
// For each (company, city) we walk the *canonical* leaf set of the catalog —
// one diet_calories row per (tier_id, diet_option_id) group, picking the
// lowest kcal entry. Different kcal levels of the same option share the same
// dish lineup (only portion sizes differ — verified), so this dedupes ~7×
// without losing any dish-level detail.
//
// For each (target, date) we hit
//   GET /company-card/{companyId}/menu/{dietCaloriesId}/city/{cityId}/date/{D}
// (optionally ?tierId=...) and persist into:
//   - meals                       (canonical dish per (company, name)).
//   - meals_history               (append-only fingerprint drift events).
//   - meal_ingredients            (current structured rows, replaced on drift).
//   - meal_ingredients_snapshots  (append-only JSONB list on drift).
//   - daily_menu                  (append-only event log).
//
// At end of run, all meal_ids that were inserted or fingerprint-drifted get
// queued for embedding via scraper/embed-queue.ts; index.ts flushes them.

import { createHash } from "node:crypto";

import {
  get,
  parseInfoMacros,
  parseKcalNumber,
  parseGrams,
  nextNDates,
  HttpError,
} from "../api";
import { q } from "../db";
import { enqueueMealForEmbedding } from "../embed-queue";
import type {
  DeepReadonly,
  MealDetails,
  MealOption,
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
}

const errMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const loadCompanyConfig = async (
  companyId: string
): Promise<CompanyMenuConfig | null> => {
  const res = await q<{
    menu_enabled: boolean | null;
    menu_days_ahead: number | null;
  }>(
    `SELECT menu_enabled, menu_days_ahead FROM companies WHERE company_id = $1`,
    [companyId]
  );
  if (res.rowCount === 0) {
    return null;
  }
  const [row] = res.rows;
  return {
    menu_days_ahead: row.menu_days_ahead ?? DEFAULT_MENU_DAYS,
    menu_enabled: row.menu_enabled !== false,
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

interface IngredientRow {
  position: number;
  name_raw: string;
  name_normalized: string;
  is_major: boolean;
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
  return out.replaceAll(/\s+/g, " ").trim();
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

interface MealFields {
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
  ingredients_raw: string | null;
  ingredients: IngredientRow[];
  fingerprint: string;
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

/**
 * Fingerprint over the meal's mutable attributes. Drift on any of these
 * triggers a meals_history row, a re-embed, and a meal_ingredients refresh.
 * Allergens are pre-sorted in extractAllergens; ingredients_raw mirrors the
 * API's verbatim list order.
 */
const fingerprintOfMeal = (
  fields: Readonly<{
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
    allergens: readonly string[];
    ingredients_raw: string | null;
  }>
): string => {
  const payload = JSON.stringify([
    fields.name ?? "",
    fields.label ?? "",
    fields.thermo ?? "",
    fields.kcal,
    fields.protein_g,
    fields.fat_g,
    fields.carbs_g,
    fields.fiber_g,
    fields.sugar_g,
    fields.saturated_fat_g,
    fields.salt_g,
    [...fields.allergens].toSorted(),
    fields.ingredients_raw ?? "",
  ]);
  return createHash("sha256").update(payload).digest("hex");
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

const mealFieldsFromOption = (option: DeepReadonly<MealOption>): MealFields => {
  const { details } = option;
  const macros = parseMacros(details, option.info);
  const name = option.name ?? details?.name ?? null;
  const reviews_number = option.reviewsNumber ?? null;
  const reviews_score = option.reviewsScore ?? null;
  const label = option.label ?? null;
  const thermo = option.thermo ?? details?.thermo ?? null;
  const ingredients_raw = extractIngredientsRaw(details);
  const allergens = extractAllergens(details);
  const fiber_g = parseGrams(details?.dietaryFiber);
  const sugar_g = parseGrams(details?.sugar);
  const saturated_fat_g = parseGrams(details?.saturatedFattyAcids);
  const salt_g = parseGrams(details?.salt);

  const fingerprint = fingerprintOfMeal({
    allergens,
    carbs_g: macros.carbs_g,
    fat_g: macros.fat_g,
    fiber_g,
    ingredients_raw,
    kcal: macros.kcal,
    label,
    name,
    protein_g: macros.protein_g,
    salt_g,
    saturated_fat_g,
    sugar_g,
    thermo,
  });

  return {
    allergens,
    api_meal_slot_id: option.dietCaloriesMealId,
    carbs_g: macros.carbs_g,
    fat_g: macros.fat_g,
    fiber_g,
    fingerprint,
    image_url: details?.imageUrl ?? null,
    ingredients: parseStructuredIngredients(details),
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

/**
 * Replace the meal's current ingredient rows and append a JSONB snapshot
 * carrying the meal's fingerprint at the time of capture. Called on initial
 * insert AND on every fingerprint drift.
 */
const writeIngredients = async (
  mealId: number,
  fingerprint: string,
  ingredients: readonly Readonly<IngredientRow>[]
): Promise<void> => {
  await q(`DELETE FROM meal_ingredients WHERE meal_id = $1`, [mealId]);
  if (ingredients.length > 0) {
    const FIELDS = 5;
    const placeholders: string[] = [];
    const params: unknown[] = [];
    for (let i = 0; i < ingredients.length; i += 1) {
      const base = i * FIELDS;
      placeholders.push(
        `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5})`
      );
      const ing = ingredients[i];
      params.push(
        mealId,
        ing.position,
        ing.name_raw,
        ing.name_normalized,
        ing.is_major
      );
    }
    await q(
      `INSERT INTO meal_ingredients
         (meal_id, position, name_raw, name_normalized, is_major)
       VALUES ${placeholders.join(",")}`,
      params
    );
  }
  await q(
    `INSERT INTO meal_ingredients_snapshots
       (meal_id, fingerprint, ingredients)
     VALUES ($1,$2,$3::jsonb)`,
    [mealId, fingerprint, JSON.stringify(ingredients)]
  );
};

/**
 * Upsert one dish, keyed by (company_id, name).
 *
 * Returns the row's stable `meal_id` plus a `touched` flag (true on insert OR
 * fingerprint drift). On touch the caller also rewrites meal_ingredients and
 * queues the meal for re-embedding.
 */
const upsertMeal = async (
  companyId: string,
  m: DeepReadonly<MealFields>
): Promise<{ meal_id: number | null; touched: boolean; drifted: boolean }> => {
  const trimmed = m.name?.trim() ?? "";
  if (trimmed === "") {
    return { drifted: false, meal_id: null, touched: false };
  }
  const name = trimmed;

  const res = await q<{
    id: number;
    old_fingerprint: string | null;
    was_insert: boolean;
  }>(
    `WITH prev AS (
       SELECT id, fingerprint AS old_fp
       FROM meals
       WHERE company_id = $1 AND name = $2
     )
     INSERT INTO meals (
       company_id, name, label, thermo,
       kcal, protein_g, fat_g, carbs_g, fiber_g, sugar_g,
       saturated_fat_g, salt_g, image_url,
       reviews_score, reviews_number, allergens, ingredients_raw,
       fingerprint, first_seen_at, last_seen_at, updated_at
     ) VALUES (
       $1, $2, $3, $4,
       $5, $6, $7, $8, $9, $10,
       $11, $12, $13,
       $14, $15, $16, $17,
       $18, NOW(), NOW(), NOW()
     )
     ON CONFLICT (company_id, name) DO UPDATE SET
       label           = EXCLUDED.label,
       thermo          = EXCLUDED.thermo,
       kcal            = EXCLUDED.kcal,
       protein_g       = EXCLUDED.protein_g,
       fat_g           = EXCLUDED.fat_g,
       carbs_g         = EXCLUDED.carbs_g,
       fiber_g         = EXCLUDED.fiber_g,
       sugar_g         = EXCLUDED.sugar_g,
       saturated_fat_g = EXCLUDED.saturated_fat_g,
       salt_g          = EXCLUDED.salt_g,
       image_url       = EXCLUDED.image_url,
       reviews_score   = EXCLUDED.reviews_score,
       reviews_number  = EXCLUDED.reviews_number,
       allergens       = EXCLUDED.allergens,
       ingredients_raw = EXCLUDED.ingredients_raw,
       fingerprint     = EXCLUDED.fingerprint,
       last_seen_at    = NOW(),
       updated_at      = CASE
         WHEN meals.fingerprint IS DISTINCT FROM EXCLUDED.fingerprint THEN NOW()
         ELSE meals.updated_at
       END
     RETURNING id,
               (SELECT old_fp FROM prev) AS old_fingerprint,
               (xmax = 0) AS was_insert`,
    [
      companyId,
      name,
      m.label,
      m.thermo,
      m.kcal,
      m.protein_g,
      m.fat_g,
      m.carbs_g,
      m.fiber_g,
      m.sugar_g,
      m.saturated_fat_g,
      m.salt_g,
      m.image_url,
      m.reviews_score,
      m.reviews_number,
      m.allergens,
      m.ingredients_raw,
      m.fingerprint,
    ]
  );

  const [row] = res.rows;
  if (row === undefined) {
    return { drifted: false, meal_id: null, touched: false };
  }

  const wasInsert = row.was_insert;
  const oldFp = row.old_fingerprint ?? null;
  const drifted = !wasInsert && oldFp !== null && oldFp !== m.fingerprint;

  if (drifted) {
    await q(
      `INSERT INTO meals_history (
         meal_id, fingerprint, kcal, protein_g, fat_g, carbs_g,
         fiber_g, sugar_g, saturated_fat_g, salt_g,
         reviews_score, reviews_number
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        row.id,
        m.fingerprint,
        m.kcal,
        m.protein_g,
        m.fat_g,
        m.carbs_g,
        m.fiber_g,
        m.sugar_g,
        m.saturated_fat_g,
        m.salt_g,
        m.reviews_score,
        m.reviews_number,
      ]
    );
  }

  const touched = wasInsert || drifted;
  return { drifted, meal_id: row.id, touched };
};

interface DailyMenuRow {
  company_id: string;
  city_id: number;
  diet_calories_id: number;
  tier_id: number | null;
  menu_date: string;
  slot_name: string | null;
  meal_id: number | null;
  api_meal_slot_id: number;
  is_default: boolean;
}

/**
 * Bulk-insert daily_menu rows in a single multi-VALUES statement.
 * 9 fields × N rows = 9N parameters. With ~25 rows per menu fetch that's ~225
 * parameters per call — well under PG's 65k limit.
 */
const bulkInsertDailyMenu = async (
  rows: readonly Readonly<DailyMenuRow>[]
): Promise<void> => {
  if (rows.length === 0) {
    return;
  }
  const FIELDS = 9;
  const placeholders: string[] = [];
  const params: unknown[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const base = i * FIELDS;
    placeholders.push(
      `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9})`
    );
    const r = rows[i];
    params.push(
      r.company_id,
      r.city_id,
      r.diet_calories_id,
      r.tier_id,
      r.menu_date,
      r.slot_name,
      r.meal_id,
      r.api_meal_slot_id,
      r.is_default
    );
  }
  await q(
    `INSERT INTO daily_menu
       (company_id, city_id, diet_calories_id, tier_id, menu_date, slot_name, meal_id, api_meal_slot_id, is_default)
     VALUES ${placeholders.join(",")}`,
    params
  );
};

// ── per-fetch processor ───────────────────────────────────────────────────────

interface FetchResult {
  mealsTouched: number;
  dailyMenuRows: number;
  fetched: boolean;
  errored?: boolean;
}

const processOneMenu = async (
  companyId: string,
  cityId: number,
  target: Readonly<MenuTarget>,
  date: string
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
      return { dailyMenuRows: 0, fetched: false, mealsTouched: 0 };
    }
    throw error;
  }

  // oxlint-disable-next-line eqeqeq -- intentional == for null/undefined; cf-fetch may yield undefined on transport error
  if (response == null || !Array.isArray(response.meals)) {
    return { dailyMenuRows: 0, fetched: true, mealsTouched: 0 };
  }

  const dailyRows: DailyMenuRow[] = [];
  let mealsTouched = 0;

  for (const slot of response.meals) {
    if (!Array.isArray(slot.options)) {
      continue;
    }
    for (const option of slot.options) {
      // oxlint-disable-next-line eqeqeq -- intentional == for null/undefined
      if (option.dietCaloriesMealId == null) {
        continue;
      }
      const fields = mealFieldsFromOption(option);
      const { meal_id, touched } = await upsertMeal(companyId, fields);
      if (touched && meal_id !== null) {
        mealsTouched += 1;
        // Refresh structured ingredients + append snapshot whenever the meal
        // is new or drifted. The drifted case must run for both fp changes
        // and was-insert because new meals start with no rows.
        await writeIngredients(meal_id, fields.fingerprint, fields.ingredients);
        enqueueMealForEmbedding(meal_id);
      }
      dailyRows.push({
        api_meal_slot_id: option.dietCaloriesMealId,
        city_id: cityId,
        company_id: companyId,
        diet_calories_id: target.diet_calories_id,
        is_default: slot.baseDietCaloriesMealId === option.dietCaloriesMealId,
        meal_id,
        menu_date: date,
        slot_name: slot.name ?? null,
        tier_id: target.tier_id,
      });
    }
  }

  await bulkInsertDailyMenu(dailyRows);
  return { dailyMenuRows: dailyRows.length, fetched: true, mealsTouched };
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
): Promise<void> => {
  const t0 = Date.now();

  const cfg = await loadCompanyConfig(companyId);
  if (cfg === null) {
    console.warn(
      `[menus] ${companyId}: no companies row, skipping (run catalog first)`
    );
    return;
  }
  if (!cfg.menu_enabled) {
    console.log(`[menus] ${companyId}: menu disabled, skipping`);
    return;
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
    return;
  }

  const totalCalls = targets.length * dates.length;
  console.log(
    `[menus] ${companyId} / city=${cityId} → ${targets.length} targets × ${dates.length} days = ${totalCalls} calls`
  );

  const work: { target: MenuTarget; date: string }[] = [];
  for (const target of targets) {
    for (const date of dates) {
      work.push({ date, target });
    }
  }

  let totalMeals = 0;
  let totalDailyMenu = 0;
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
        return await processOneMenu(companyId, cityId, target, date);
      } catch (error) {
        console.warn(
          `[menus] ${companyId} dc=${target.diet_calories_id} tier=${target.tier_id ?? "-"} @ ${date}: ${errMessage(error)}`
        );
        return {
          dailyMenuRows: 0,
          errored: true,
          fetched: false,
          mealsTouched: 0,
        };
      }
    }
  );

  for (const r of results) {
    totalMeals += r.mealsTouched;
    totalDailyMenu += r.dailyMenuRows;
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
    `[menus] ✓ ${companyId}: ${totalMeals} meals upserted, ${totalDailyMenu} daily_menu rows, ${totalFetched}/${totalCalls} calls fetched${errSuffix} (${elapsed}s)`
  );
};
