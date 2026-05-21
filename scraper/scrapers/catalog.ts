// Catalog scraper — diet hierarchy + per-company city snapshot.
//
// For each (company, city) we hit:
//   GET /company-card/{slug}/constant?cityId=...      — full catalog tree
//   GET /company-card/{slug}/city/{cityId}            — city-specific pricing
//
// Writes:
//   - companies            (mutable, no history)
//   - company_cities       (mutable, no history)
//   - diets                (canonical + fingerprint + diet_snapshots on drift)
//   - tiers                (same pattern + tier_snapshots)
//   - diet_options         (same pattern + diet_option_snapshots)
//   - diet_calories        (existence-only — first_seen_at / last_seen_at / is_active)
//   - diet_discounts       (canonical rows + diet_discount_snapshots on JSONB-list drift)
//
// Each scrape ends with an "existence pass" that flips is_active=FALSE +
// bumps last_seen_at on any canonical row not seen for this company.

import { get, parsePrice } from "../api";
import { q } from "../db";
import { captureDrift, fingerprintOf } from "../snapshots";
import type {
  ConstantResponse,
  CityResponse,
  CompanySearchItem,
  DeepReadonly,
  Diet,
  DietCaloriesItem,
  Discount,
  DietOption,
  DietPriceInfo,
  Tier,
} from "../types";

// ── helpers ───────────────────────────────────────────────────────────────────

const errMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

interface CompanyRow {
  name: string;
  logoUrl: string | null;
  rateValue: number | null;
  feedbackValue: number | null;
  feedbackNumber: number | null;
  awarded: boolean;
  priceCategory: string | null;
  deliveryOnSaturday: boolean | null;
  deliveryOnSunday: boolean | null;
  menuEnabled: boolean | null;
  menuDaysAhead: number | null;
  ordersEnabled: boolean | null;
  deliveryEnabled: boolean | null;
  deliveryInfoText: string | null;
  deliveryInfoDate: string | null;
  dietlyDelivery: boolean | null;
  recentlyAdded: boolean | null;
  inviteCodeDiscountPercent: number | null;
  // Dietly's own per-catering switches for showing nutrition / ingredients
  // panels in their UI. When false, dietly's clients hide those panels even
  // though the menu API returns a body. We honor the same flags during the
  // menus scrape and write nulls instead.
  nutritionVisible: boolean;
  ingredientsVisible: boolean;
}

// oxlint-disable-next-line eslint/complexity -- linear field mapping; one branch per column is the goal
const projectCompanyRow = (
  companyId: string,
  constant: DeepReadonly<ConstantResponse>,
  cityData: DeepReadonly<CityResponse>,
  awardedExtras: DeepReadonly<CompanySearchItem> | null
): CompanyRow => {
  const h = constant.companyHeader;
  const p = constant.companyParams;
  const m = constant.menuSettings;
  const fs = constant.formSettings;
  const di = h.deliveryInfo ?? null;
  return {
    awarded: h.awarded ?? false,
    deliveryEnabled: cityData.companySettings.deliveryEnabled ?? null,
    deliveryInfoDate: di?.date ?? null,
    deliveryInfoText: di?.text ?? null,
    deliveryOnSaturday: p.deliveryOnSaturday ?? null,
    deliveryOnSunday: p.deliveryOnSunday ?? null,
    dietlyDelivery: h.dietlyDelivery ?? null,
    feedbackNumber: h.feedbackNumber ?? null,
    feedbackValue: h.feedbackValue ?? null,
    // The two flags default TRUE when missing — historically that was the
    // assumption and we don't want a transient response shape change to flip
    // every catering off at once.
    ingredientsVisible: fs?.visibleIngredientsInDietly ?? true,
    inviteCodeDiscountPercent: awardedExtras?.inviteCodeDiscountPercent ?? null,
    logoUrl: h.logoUrl ?? null,
    menuDaysAhead: m.menuDaysAhead ?? null,
    menuEnabled: m.menuEnabled ?? null,
    name: h.name ?? companyId,
    nutritionVisible: fs?.visibleNutritionInDietly ?? true,
    ordersEnabled: cityData.companySettings.ordersEnabled ?? null,
    priceCategory: cityData.companyPriceCategory ?? null,
    rateValue: h.rateValue ?? null,
    recentlyAdded: h.recentlyAdded ?? null,
  };
};

/**
 * Append a row to `company_ratings_history` only when the rating fields have
 * actually changed since the last captured row. Keeps the table sparse — it
 * grows with review velocity, not scrape frequency. NULLs are compared with
 * IS DISTINCT FROM so a "no reviews yet" → "first review" transition is
 * captured. Idempotent: a no-op INSERT when nothing moved.
 */
const captureCompanyRatingIfChanged = async (
  companyId: string,
  avgScore: number | null,
  feedbackValue: number | null,
  feedbackNumber: number | null
): Promise<void> => {
  await q(
    `INSERT INTO company_ratings_history
       (company_id, avg_score, feedback_value, feedback_number)
     SELECT $1::text, $2::numeric, $3::numeric, $4::int
     WHERE NOT EXISTS (
       SELECT 1 FROM (
         SELECT avg_score, feedback_value, feedback_number
         FROM company_ratings_history
         WHERE company_id = $1::text
         ORDER BY captured_at DESC
         LIMIT 1
       ) latest
       WHERE latest.avg_score       IS NOT DISTINCT FROM $2::numeric
         AND latest.feedback_value  IS NOT DISTINCT FROM $3::numeric
         AND latest.feedback_number IS NOT DISTINCT FROM $4::int
     )`,
    [companyId, avgScore, feedbackValue, feedbackNumber]
  );
};

const upsertCompany = async (
  companyId: string,
  constant: DeepReadonly<ConstantResponse>,
  cityData: DeepReadonly<CityResponse>,
  awardedExtras: DeepReadonly<CompanySearchItem> | null
): Promise<void> => {
  const r = projectCompanyRow(companyId, constant, cityData, awardedExtras);
  await q(
    `INSERT INTO companies
       (company_id, name, logo_url, avg_score, feedback_value, feedback_number,
        awarded, price_category, delivery_on_saturday, delivery_on_sunday,
        menu_enabled, menu_days_ahead, orders_enabled, delivery_enabled,
        delivery_info_text, delivery_info_date, dietly_delivery, recently_added,
        invite_code_discount_percent,
        nutrition_visible, ingredients_visible)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     ON CONFLICT (company_id) DO UPDATE SET
       name               = EXCLUDED.name,
       logo_url           = EXCLUDED.logo_url,
       avg_score          = EXCLUDED.avg_score,
       feedback_value     = EXCLUDED.feedback_value,
       feedback_number    = EXCLUDED.feedback_number,
       awarded            = EXCLUDED.awarded,
       price_category     = EXCLUDED.price_category,
       delivery_on_saturday = EXCLUDED.delivery_on_saturday,
       delivery_on_sunday   = EXCLUDED.delivery_on_sunday,
       menu_enabled       = EXCLUDED.menu_enabled,
       menu_days_ahead    = EXCLUDED.menu_days_ahead,
       orders_enabled     = EXCLUDED.orders_enabled,
       delivery_enabled   = EXCLUDED.delivery_enabled,
       delivery_info_text = EXCLUDED.delivery_info_text,
       delivery_info_date = EXCLUDED.delivery_info_date,
       dietly_delivery    = EXCLUDED.dietly_delivery,
       recently_added     = EXCLUDED.recently_added,
       invite_code_discount_percent = EXCLUDED.invite_code_discount_percent,
       nutrition_visible    = EXCLUDED.nutrition_visible,
       ingredients_visible  = EXCLUDED.ingredients_visible,
       updated_at         = NOW()`,
    [
      companyId,
      r.name,
      r.logoUrl,
      r.rateValue,
      r.feedbackValue,
      r.feedbackNumber,
      r.awarded,
      r.priceCategory,
      r.deliveryOnSaturday,
      r.deliveryOnSunday,
      r.menuEnabled,
      r.menuDaysAhead,
      r.ordersEnabled,
      r.deliveryEnabled,
      r.deliveryInfoText,
      r.deliveryInfoDate,
      r.dietlyDelivery,
      r.recentlyAdded,
      r.inviteCodeDiscountPercent,
      r.nutritionVisible,
      r.ingredientsVisible,
    ]
  );

  await captureCompanyRatingIfChanged(
    companyId,
    r.rateValue,
    r.feedbackValue,
    r.feedbackNumber
  );
};

const upsertCompanyCity = async (
  companyId: string,
  cityId: number,
  cityData: DeepReadonly<CityResponse>,
  awardedExtras: DeepReadonly<CompanySearchItem> | null
): Promise<void> => {
  const lp = cityData.lowestPrice;
  const standard = parsePrice(lp?.standard);
  const menuConfig = parsePrice(lp?.menuConfiguration);
  const deliveryFee = cityData.citySearchResult.deliveryFee ?? null;
  const ordersEnabled = cityData.companySettings.ordersEnabled ?? null;
  const deliveryEnabled = cityData.companySettings.deliveryEnabled ?? null;
  const orderPossibleOn = awardedExtras?.orderPossibleOn ?? null;
  const orderPossibleTo = awardedExtras?.orderPossibleTo ?? null;

  await q(
    `INSERT INTO company_cities
       (company_id, city_id, delivery_fee, lowest_price_standard,
        lowest_price_menu_config, orders_enabled, delivery_enabled,
        order_possible_on, order_possible_to)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (company_id, city_id) DO UPDATE SET
       delivery_fee             = EXCLUDED.delivery_fee,
       lowest_price_standard    = EXCLUDED.lowest_price_standard,
       lowest_price_menu_config = EXCLUDED.lowest_price_menu_config,
       orders_enabled           = EXCLUDED.orders_enabled,
       delivery_enabled         = EXCLUDED.delivery_enabled,
       order_possible_on        = EXCLUDED.order_possible_on,
       order_possible_to        = EXCLUDED.order_possible_to`,
    [
      companyId,
      cityId,
      deliveryFee,
      standard,
      menuConfig,
      ordersEnabled,
      deliveryEnabled,
      orderPossibleOn,
      orderPossibleTo,
    ]
  );
};

// ── diet hierarchy upserts ────────────────────────────────────────────────────

const dietAttrPayload = (
  diet: DeepReadonly<Diet>
): Record<string, unknown> => ({
  avg_score: diet.avgScore ?? null,
  awarded: diet.awarded ?? false,
  description: diet.description ?? null,
  diet_meal_count: diet.dietMealCount ?? null,
  diet_tag: diet.dietTag ?? null,
  feedback_number: diet.feedbackNumber ?? null,
  feedback_value: diet.feedbackValue ?? null,
  is_menu_configuration: diet.isMenuConfiguration ?? false,
  name: diet.name,
});

/**
 * Read the canonical row's current attributes, re-hash them, and return the
 * resulting fingerprint. This is the "trust the data, not the stored hash"
 * path — used as the drift comparison baseline so manual UPDATEs that didn't
 * also recompute the fingerprint still get detected.
 */
const currentDietFp = async (
  companyId: string,
  dietId: number
): Promise<string | null> => {
  const { rows } = await q<{
    name: string | null;
    description: string | null;
    diet_tag: string | null;
    is_menu_configuration: boolean | null;
    diet_meal_count: number | null;
    awarded: boolean | null;
    avg_score: string | null;
    feedback_value: string | null;
    feedback_number: number | null;
  }>(
    `SELECT name, description, diet_tag, is_menu_configuration,
            diet_meal_count, awarded, avg_score, feedback_value, feedback_number
       FROM diets
      WHERE company_id = $1 AND diet_id = $2`,
    [companyId, dietId]
  );
  const [r] = rows;
  if (r === undefined) {
    return null;
  }
  // Reconstruct the same payload shape as dietAttrPayload, but from the
  // stored row. Numeric columns come back as strings from pg — coerce.
  const payload = {
    avg_score: r.avg_score === null ? null : Number(r.avg_score),
    awarded: r.awarded ?? false,
    description: r.description ?? null,
    diet_meal_count: r.diet_meal_count ?? null,
    diet_tag: r.diet_tag ?? null,
    feedback_number: r.feedback_number ?? null,
    feedback_value: r.feedback_value === null ? null : Number(r.feedback_value),
    is_menu_configuration: r.is_menu_configuration ?? false,
    name: r.name ?? "",
  };
  return fingerprintOf(payload);
};

const upsertDiet = async (
  companyId: string,
  diet: DeepReadonly<Diet>
): Promise<void> => {
  const payload = dietAttrPayload(diet);
  const fp = fingerprintOf(payload);

  // Re-hash the row's stored attrs BEFORE the upsert so a manual UPDATE that
  // didn't touch the fingerprint still trips drift detection.
  const prevFp = await currentDietFp(companyId, diet.dietId);

  await q(
    `INSERT INTO diets
       (company_id, diet_id, name, description, diet_tag, is_menu_configuration,
        diet_meal_count, awarded, avg_score, feedback_value, feedback_number,
        fingerprint, first_seen_at, last_seen_at, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),NOW(),TRUE)
     ON CONFLICT (company_id, diet_id) DO UPDATE SET
       name                  = EXCLUDED.name,
       description           = EXCLUDED.description,
       diet_tag              = EXCLUDED.diet_tag,
       is_menu_configuration = EXCLUDED.is_menu_configuration,
       diet_meal_count       = EXCLUDED.diet_meal_count,
       awarded               = EXCLUDED.awarded,
       avg_score             = EXCLUDED.avg_score,
       feedback_value        = EXCLUDED.feedback_value,
       feedback_number       = EXCLUDED.feedback_number,
       fingerprint           = EXCLUDED.fingerprint,
       last_seen_at          = NOW(),
       is_active             = TRUE`,
    [
      companyId,
      diet.dietId,
      diet.name,
      diet.description ?? null,
      diet.dietTag ?? null,
      diet.isMenuConfiguration ?? false,
      diet.dietMealCount ?? null,
      diet.awarded ?? false,
      diet.avgScore ?? null,
      diet.feedbackValue ?? null,
      diet.feedbackNumber ?? null,
      fp,
    ]
  );

  // Snapshot on (a) initial creation (prevFp === null) or (b) data drift
  // (prevFp !== fp). For (b) we force the insert: the latest snapshot may
  // coincidentally share `fp` (manual rollback / round-trip), which the
  // helper's own dedup would otherwise filter out.
  if (prevFp === null) {
    await captureDrift({
      keyCols: ["company_id", "diet_id"],
      keyValues: [companyId, diet.dietId],
      newFingerprint: fp,
      payload,
      snapshotTable: "diet_snapshots",
      table: "diets",
    });
  } else if (prevFp !== fp) {
    await captureDrift({
      force: true,
      keyCols: ["company_id", "diet_id"],
      keyValues: [companyId, diet.dietId],
      newFingerprint: fp,
      payload,
      snapshotTable: "diet_snapshots",
      table: "diets",
    });
  }
};

const tierAttrPayload = (
  tier: DeepReadonly<Tier>
): Record<string, unknown> => ({
  meals_number: tier.mealsNumber ?? null,
  name: tier.name,
  tag: tier.tag ?? null,
});

const currentTierFp = async (
  companyId: string,
  dietId: number,
  tierId: number
): Promise<string | null> => {
  const { rows } = await q<{
    name: string | null;
    meals_number: number | null;
    tag: string | null;
  }>(
    `SELECT name, meals_number, tag
       FROM tiers
      WHERE company_id = $1 AND diet_id = $2 AND tier_id = $3`,
    [companyId, dietId, tierId]
  );
  const [r] = rows;
  if (r === undefined) {
    return null;
  }
  return fingerprintOf({
    meals_number: r.meals_number ?? null,
    name: r.name ?? "",
    tag: r.tag ?? null,
  });
};

const upsertTier = async (
  companyId: string,
  dietId: number,
  tier: DeepReadonly<Tier>
): Promise<void> => {
  const payload = tierAttrPayload(tier);
  const fp = fingerprintOf(payload);
  const prevFp = await currentTierFp(companyId, dietId, tier.tierId);

  await q(
    `INSERT INTO tiers
       (company_id, diet_id, tier_id, name, meals_number, tag,
        fingerprint, first_seen_at, last_seen_at, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW(),TRUE)
     ON CONFLICT (company_id, diet_id, tier_id) DO UPDATE SET
       name         = EXCLUDED.name,
       meals_number = EXCLUDED.meals_number,
       tag          = EXCLUDED.tag,
       fingerprint  = EXCLUDED.fingerprint,
       last_seen_at = NOW(),
       is_active    = TRUE`,
    [
      companyId,
      dietId,
      tier.tierId,
      tier.name,
      tier.mealsNumber ?? null,
      tier.tag ?? null,
      fp,
    ]
  );

  if (prevFp === null) {
    await captureDrift({
      keyCols: ["company_id", "diet_id", "tier_id"],
      keyValues: [companyId, dietId, tier.tierId],
      newFingerprint: fp,
      payload,
      snapshotTable: "tier_snapshots",
      table: "tiers",
    });
  } else if (prevFp !== fp) {
    await captureDrift({
      force: true,
      keyCols: ["company_id", "diet_id", "tier_id"],
      keyValues: [companyId, dietId, tier.tierId],
      newFingerprint: fp,
      payload,
      snapshotTable: "tier_snapshots",
      table: "tiers",
    });
  }
};

const optionAttrPayload = (
  opt: DeepReadonly<DietOption>
): Record<string, unknown> => ({
  diet_option_tag: opt.dietOptionTag ?? null,
  is_default: opt.defaultOption ?? false,
  name: opt.name,
});

const currentOptionFp = async (
  companyId: string,
  dietId: number,
  tierId: number,
  dietOptionId: number
): Promise<string | null> => {
  const { rows } = await q<{
    name: string | null;
    diet_option_tag: string | null;
    is_default: boolean | null;
  }>(
    `SELECT name, diet_option_tag, is_default
       FROM diet_options
      WHERE company_id = $1 AND diet_id = $2 AND tier_id = $3 AND diet_option_id = $4`,
    [companyId, dietId, tierId, dietOptionId]
  );
  const [r] = rows;
  if (r === undefined) {
    return null;
  }
  return fingerprintOf({
    diet_option_tag: r.diet_option_tag ?? null,
    is_default: r.is_default ?? false,
    name: r.name ?? "",
  });
};

const upsertOption = async (
  companyId: string,
  dietId: number,
  tierId: number,
  opt: DeepReadonly<DietOption>
): Promise<void> => {
  const payload = optionAttrPayload(opt);
  const fp = fingerprintOf(payload);
  const prevFp = await currentOptionFp(
    companyId,
    dietId,
    tierId,
    opt.dietOptionId
  );

  await q(
    `INSERT INTO diet_options
       (company_id, diet_id, tier_id, diet_option_id, tier_diet_option_id,
        name, diet_option_tag, is_default,
        fingerprint, first_seen_at, last_seen_at, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW(),TRUE)
     ON CONFLICT (company_id, diet_id, tier_id, diet_option_id) DO UPDATE SET
       tier_diet_option_id = EXCLUDED.tier_diet_option_id,
       name                = EXCLUDED.name,
       diet_option_tag     = EXCLUDED.diet_option_tag,
       is_default          = EXCLUDED.is_default,
       fingerprint         = EXCLUDED.fingerprint,
       last_seen_at        = NOW(),
       is_active           = TRUE`,
    [
      companyId,
      dietId,
      tierId,
      opt.dietOptionId,
      opt.tierDietOptionId ?? null,
      opt.name,
      opt.dietOptionTag ?? null,
      opt.defaultOption ?? false,
      fp,
    ]
  );

  if (prevFp === null) {
    await captureDrift({
      keyCols: ["company_id", "diet_id", "tier_id", "diet_option_id"],
      keyValues: [companyId, dietId, tierId, opt.dietOptionId],
      newFingerprint: fp,
      payload,
      snapshotTable: "diet_option_snapshots",
      table: "diet_options",
    });
  } else if (prevFp !== fp) {
    await captureDrift({
      force: true,
      keyCols: ["company_id", "diet_id", "tier_id", "diet_option_id"],
      keyValues: [companyId, dietId, tierId, opt.dietOptionId],
      newFingerprint: fp,
      payload,
      snapshotTable: "diet_option_snapshots",
      table: "diet_options",
    });
  }
};

/**
 * Upsert one diet_calories leaf. The new schema has no `valid_to`/`valid_from`:
 * we maintain existence via `first_seen_at` (preserve), `last_seen_at`
 * (bump), `is_active` (TRUE on upsert; flipped FALSE by the existence pass).
 *
 * `tier_id` and `diet_option_id` are NOT NULL in the new schema. For "ready"
 * diets that the API doesn't tier or option, we coerce both to 0 — a synthetic
 * placeholder. That requires a corresponding placeholder option to satisfy
 * the FK; we plant one in `ensureReadyPlaceholder`.
 */
const upsertDietCalories = async (
  companyId: string,
  dietId: number,
  tierId: number,
  dietOptionId: number,
  dietCaloriesId: number,
  calories: number | null
): Promise<void> => {
  await q(
    `INSERT INTO diet_calories
       (diet_calories_id, company_id, diet_id, tier_id, diet_option_id, calories,
        first_seen_at, last_seen_at, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW(),TRUE)
     ON CONFLICT (company_id, diet_calories_id) DO UPDATE SET
       diet_id        = EXCLUDED.diet_id,
       tier_id        = EXCLUDED.tier_id,
       diet_option_id = EXCLUDED.diet_option_id,
       calories       = EXCLUDED.calories,
       last_seen_at   = NOW(),
       is_active      = TRUE`,
    [dietCaloriesId, companyId, dietId, tierId, dietOptionId, calories ?? 0]
  );
};

/**
 * For "ready"/flat diets that the API surfaces without tiers/options, plant
 * a single (tier_id=0, diet_option_id=0) placeholder so the diet_calories
 * leaves can FK to it. Idempotent — minimum-shape rows that never drift.
 */
const ensureReadyPlaceholder = async (
  companyId: string,
  dietId: number
): Promise<void> => {
  await q(
    `INSERT INTO tiers
       (company_id, diet_id, tier_id, name, meals_number, tag,
        fingerprint, first_seen_at, last_seen_at, is_active)
     VALUES ($1,$2,0,'(ready)',NULL,NULL,'ready-placeholder',NOW(),NOW(),TRUE)
     ON CONFLICT (company_id, diet_id, tier_id) DO UPDATE SET
       last_seen_at = NOW(),
       is_active    = TRUE`,
    [companyId, dietId]
  );
  await q(
    `INSERT INTO diet_options
       (company_id, diet_id, tier_id, diet_option_id, tier_diet_option_id,
        name, diet_option_tag, is_default,
        fingerprint, first_seen_at, last_seen_at, is_active)
     VALUES ($1,$2,0,0,NULL,'(ready)',NULL,TRUE,'ready-placeholder',NOW(),NOW(),TRUE)
     ON CONFLICT (company_id, diet_id, tier_id, diet_option_id) DO UPDATE SET
       last_seen_at = NOW(),
       is_active    = TRUE`,
    [companyId, dietId]
  );
};

// ── diet_discounts: canonical rows + JSONB snapshot on drift ─────────────────

/**
 * Upsert the full discount ladder for (company, diet). Each discount row is
 * keyed by (company_id, diet_id, minimum_days, discount_type) UNIQUE.
 * Compute a single fingerprint over the SORTED list of triples; if it differs
 * from the latest diet_discount_snapshots row, append a new snapshot with the
 * full JSONB list.
 */
const canonicalSortDiscounts = (
  rows: readonly Readonly<{
    discount: number;
    minimum_days: number;
    discount_type: string;
  }>[]
): { discount: number; minimum_days: number; discount_type: string }[] =>
  [...rows].toSorted((a, b) => {
    if (a.minimum_days !== b.minimum_days) {
      return a.minimum_days - b.minimum_days;
    }
    if (a.discount_type !== b.discount_type) {
      return a.discount_type < b.discount_type ? -1 : 1;
    }
    return a.discount - b.discount;
  });

const currentDiscountsFp = async (
  companyId: string,
  dietId: number
): Promise<string | null> => {
  const { rows } = await q<{
    discount: string;
    minimum_days: number;
    discount_type: string;
  }>(
    `SELECT discount, minimum_days, discount_type
       FROM diet_discounts
      WHERE company_id = $1 AND diet_id = $2 AND is_active = TRUE`,
    [companyId, dietId]
  );
  if (rows.length === 0) {
    // No discounts known yet — return null so the FIRST observed list (even
    // an empty one) gets snapshotted.
    return null;
  }
  const sorted = canonicalSortDiscounts(
    rows.map(
      (
        r: Readonly<{
          discount: string;
          minimum_days: number;
          discount_type: string;
        }>
      ) => ({
        discount: Number(r.discount),
        discount_type: r.discount_type,
        minimum_days: r.minimum_days,
      })
    )
  );
  return fingerprintOf({ discounts: sorted });
};

const syncDietDiscounts = async (
  companyId: string,
  dietId: number,
  apiDiscounts: readonly DeepReadonly<Discount>[]
): Promise<void> => {
  const prevFp = await currentDiscountsFp(companyId, dietId);

  // 1. Canonical upserts. We re-activate any matching row; deactivation of
  //    missing ones happens in the existence pass.
  const seen: {
    discount: number;
    minimum_days: number;
    discount_type: string;
  }[] = [];
  for (const d of apiDiscounts) {
    const { discount } = d;
    seen.push({
      discount,
      discount_type: d.discountType,
      minimum_days: d.minimumDays,
    });
    await q(
      `INSERT INTO diet_discounts
         (company_id, diet_id, discount, minimum_days, discount_type,
          first_seen_at, last_seen_at, is_active)
       VALUES ($1,$2,$3,$4,$5,NOW(),NOW(),TRUE)
       ON CONFLICT (company_id, diet_id, minimum_days, discount_type) DO UPDATE SET
         discount     = EXCLUDED.discount,
         last_seen_at = NOW(),
         is_active    = TRUE`,
      [companyId, dietId, discount, d.minimumDays, d.discountType]
    );
  }

  // 2. JSONB-list snapshot on drift. Sort the list canonically so a reordered
  //    API response doesn't trigger spurious snapshots.
  const sorted = canonicalSortDiscounts(seen);
  const fp = fingerprintOf({ discounts: sorted });
  if (prevFp === null) {
    await captureDrift({
      keyCols: ["company_id", "diet_id"],
      keyValues: [companyId, dietId],
      newFingerprint: fp,
      payload: { discounts: JSON.stringify(sorted) },
      snapshotTable: "diet_discount_snapshots",
      table: "diet_discounts",
    });
  } else if (prevFp !== fp) {
    await captureDrift({
      force: true,
      keyCols: ["company_id", "diet_id"],
      keyValues: [companyId, dietId],
      newFingerprint: fp,
      payload: { discounts: JSON.stringify(sorted) },
      snapshotTable: "diet_discount_snapshots",
      table: "diet_discounts",
    });
  }
};

// ── existence pass — flip is_active=FALSE on rows not seen this run ──────────

interface SeenSets {
  diets: Set<number>;
  /** "diet_id|tier_id" */
  tiers: Set<string>;
  /** "diet_id|tier_id|option_id" */
  options: Set<string>;
  /** diet_calories_id (globally unique) */
  leaves: Set<number>;
  /** "diet_id|minimum_days|discount_type" */
  discounts: Set<string>;
}

const newSeen = (): SeenSets => ({
  diets: new Set(),
  discounts: new Set(),
  leaves: new Set(),
  options: new Set(),
  tiers: new Set(),
});

const keyTier = (dietId: number, tierId: number): string =>
  `${dietId}|${tierId}`;
const keyOption = (dietId: number, tierId: number, optionId: number): string =>
  `${dietId}|${tierId}|${optionId}`;
const keyDiscount = (
  dietId: number,
  minimumDays: number,
  discountType: string
): string => `${dietId}|${minimumDays}|${discountType}`;

const deactivateMissing = async (
  companyId: string,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- DeepReadonly<SeenSets> wraps inner Sets in ReadonlySet; oxlint's rule doesn't accept methods (`.has`, `.size`) on Readonly* collections as readonly even when the type is.
  seen: DeepReadonly<SeenSets>
): Promise<void> => {
  // leaves — keyed by diet_calories_id (globally unique)
  await q(
    `UPDATE diet_calories
        SET is_active    = FALSE,
            last_seen_at = NOW()
      WHERE company_id = $1
        AND diet_calories_id <> ALL($2::int[])`,
    [companyId, [...seen.leaves]]
  );

  // options — keyed by (diet_id, tier_id, diet_option_id)
  const { rows: liveOpts } = await q<{
    diet_id: number;
    tier_id: number;
    diet_option_id: number;
  }>(
    `SELECT diet_id, tier_id, diet_option_id
       FROM diet_options
      WHERE company_id = $1
        AND is_active = TRUE`,
    [companyId]
  );
  const optMissing: { d: number; t: number; o: number }[] = [];
  for (const r of liveOpts) {
    const k = keyOption(r.diet_id, r.tier_id, r.diet_option_id);
    if (!seen.options.has(k)) {
      optMissing.push({ d: r.diet_id, o: r.diet_option_id, t: r.tier_id });
    }
  }
  for (const m of optMissing) {
    await q(
      `UPDATE diet_options
          SET is_active    = FALSE,
              last_seen_at = NOW()
        WHERE company_id = $1
          AND diet_id = $2
          AND tier_id = $3
          AND diet_option_id = $4`,
      [companyId, m.d, m.t, m.o]
    );
  }

  // tiers
  const { rows: liveTiers } = await q<{ diet_id: number; tier_id: number }>(
    `SELECT diet_id, tier_id
       FROM tiers
      WHERE company_id = $1
        AND is_active = TRUE`,
    [companyId]
  );
  const tierMissing: { d: number; t: number }[] = [];
  for (const r of liveTiers) {
    const k = keyTier(r.diet_id, r.tier_id);
    if (!seen.tiers.has(k)) {
      tierMissing.push({ d: r.diet_id, t: r.tier_id });
    }
  }
  for (const m of tierMissing) {
    await q(
      `UPDATE tiers
          SET is_active    = FALSE,
              last_seen_at = NOW()
        WHERE company_id = $1
          AND diet_id = $2
          AND tier_id = $3`,
      [companyId, m.d, m.t]
    );
  }

  // diets
  await q(
    `UPDATE diets
        SET is_active    = FALSE,
            last_seen_at = NOW()
      WHERE company_id = $1
        AND diet_id <> ALL($2::int[])`,
    [companyId, [...seen.diets]]
  );

  // discounts
  const { rows: liveDiscounts } = await q<{
    diet_id: number;
    minimum_days: number;
    discount_type: string;
  }>(
    `SELECT diet_id, minimum_days, discount_type
       FROM diet_discounts
      WHERE company_id = $1
        AND is_active = TRUE`,
    [companyId]
  );
  const discMissing: {
    d: number;
    days: number;
    type: string;
  }[] = [];
  for (const r of liveDiscounts) {
    const k = keyDiscount(r.diet_id, r.minimum_days, r.discount_type);
    if (!seen.discounts.has(k)) {
      discMissing.push({
        d: r.diet_id,
        days: r.minimum_days,
        type: r.discount_type,
      });
    }
  }
  for (const m of discMissing) {
    await q(
      `UPDATE diet_discounts
          SET is_active    = FALSE,
              last_seen_at = NOW()
        WHERE company_id = $1
          AND diet_id = $2
          AND minimum_days = $3
          AND discount_type = $4`,
      [companyId, m.d, m.days, m.type]
    );
  }
};

// ── main export ───────────────────────────────────────────────────────────────

// oxlint-disable-next-line eslint/complexity -- straight-line orchestration; splitting just hides the flow
export const scrapeCatalog = async (
  companyId: string,
  cityId: number,
  awardedExtras: DeepReadonly<CompanySearchItem> | null = null
): Promise<void> => {
  console.log(`[catalog] ${companyId} / city=${cityId}`);

  const [constant, cityData] = await Promise.all([
    get<ConstantResponse>(
      `/api/mobile/open/company-card/${companyId}/constant?cityId=${cityId}`,
      { companyId }
    ),
    get<CityResponse>(
      `/api/mobile/open/company-card/${companyId}/city/${cityId}`,
      { companyId }
    ),
  ]);

  await upsertCompany(companyId, constant, cityData, awardedExtras);
  await upsertCompanyCity(companyId, cityId, cityData, awardedExtras);

  // dietPriceInfo gives kcal IDs for all diets (used for ready / non-tiered diets)
  const dietPriceMap = new Map(
    (cityData.dietPriceInfo ?? []).map((p: DeepReadonly<DietPriceInfo>) => [
      p.dietId,
      [...p.dietCaloriesIds],
    ])
  );

  const seen = newSeen();
  let totalCalories = 0;

  for (const diet of constant.companyDiets ?? []) {
    await upsertDiet(companyId, diet);
    seen.diets.add(diet.dietId);

    // Sync discounts and track which (days,type) tuples we observed.
    await syncDietDiscounts(companyId, diet.dietId, diet.discounts ?? []);
    for (const d of diet.discounts ?? []) {
      seen.discounts.add(
        keyDiscount(diet.dietId, d.minimumDays, d.discountType)
      );
    }

    if ((diet.dietTiers ?? []).length > 0) {
      // Tiered diet: full tree from /constant
      for (const tier of diet.dietTiers) {
        await upsertTier(companyId, diet.dietId, tier);
        seen.tiers.add(keyTier(diet.dietId, tier.tierId));
        for (const opt of tier.dietOptions ?? []) {
          await upsertOption(companyId, diet.dietId, tier.tierId, opt);
          seen.options.add(
            keyOption(diet.dietId, tier.tierId, opt.dietOptionId)
          );
          for (const cal of opt.dietCalories ?? []) {
            await upsertDietCalories(
              companyId,
              diet.dietId,
              tier.tierId,
              opt.dietOptionId,
              cal.dietCaloriesId,
              cal.calories
            );
            seen.leaves.add(cal.dietCaloriesId);
            totalCalories += 1;
          }
        }
      }
    } else {
      // Ready / flat diet: prefer /constant dietOptions (has calories number),
      // fall back to /city dietPriceInfo (id list only). Plant a synthetic
      // (tier_id=0, diet_option_id=0) placeholder so the FK holds.
      await ensureReadyPlaceholder(companyId, diet.dietId);
      seen.tiers.add(keyTier(diet.dietId, 0));
      seen.options.add(keyOption(diet.dietId, 0, 0));

      const fromConstant = (diet.dietOptions ?? []).flatMap(
        (o: DeepReadonly<DietOption>) =>
          (o.dietCalories ?? []).map((c: DeepReadonly<DietCaloriesItem>) => ({
            calories: c.calories,
            id: c.dietCaloriesId,
          }))
      );
      const fromCity = (dietPriceMap.get(diet.dietId) ?? []).map((id) => ({
        calories: null as number | null,
        id,
      }));
      const merged = new Map<number, number | null>();
      for (const e of [...fromConstant, ...fromCity]) {
        if (!merged.has(e.id) || merged.get(e.id) == null) {
          merged.set(e.id, e.calories);
        }
      }
      for (const [calId, calories] of merged) {
        await upsertDietCalories(companyId, diet.dietId, 0, 0, calId, calories);
        seen.leaves.add(calId);
        totalCalories += 1;
      }
    }
  }

  // Existence pass — deactivate anything not seen this run.
  if (seen.diets.size > 0) {
    await deactivateMissing(companyId, seen);
  }

  // Persist any active promo info from the company header at catalog time —
  // ensures partial / single-company runs still get current promo data.
  try {
    const { recordPromosFromConstants } = await import("./promotions.js");
    await recordPromosFromConstants(cityId, [{ companyId, constant }]);
  } catch (error) {
    console.warn(`[catalog] promo write skipped (${errMessage(error)})`);
  }

  console.log(
    `[catalog] ✓ ${companyId}: ${seen.diets.size} diets, ${totalCalories} kcal nodes`
  );
};
