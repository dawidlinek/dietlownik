import { get, parsePrice } from "../api.js";
import { q } from "../db.js";
import type {
  ConstantResponse,
  CityResponse,
  Diet,
  Tier,
  DietOption,
} from "../types.js";

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
}

const projectCompanyRow = (
  companyId: string,
  constant: ConstantResponse,
  cityData: CityResponse
): CompanyRow => {
  const h = constant.companyHeader;
  const p = constant.companyParams;
  const m = constant.menuSettings;
  return {
    awarded: h.awarded ?? false,
    deliveryEnabled: cityData.companySettings.deliveryEnabled ?? null,
    deliveryOnSaturday: p.deliveryOnSaturday ?? null,
    deliveryOnSunday: p.deliveryOnSunday ?? null,
    feedbackNumber: h.feedbackNumber ?? null,
    feedbackValue: h.feedbackValue ?? null,
    logoUrl: h.logoUrl ?? null,
    menuDaysAhead: m.menuDaysAhead ?? null,
    menuEnabled: m.menuEnabled ?? null,
    name: h.name ?? companyId,
    ordersEnabled: cityData.companySettings.ordersEnabled ?? null,
    priceCategory: cityData.companyPriceCategory ?? null,
    rateValue: h.rateValue ?? null,
  };
};

const upsertCompany = async (
  companyId: string,
  constant: ConstantResponse,
  cityData: CityResponse
): Promise<void> => {
  const r = projectCompanyRow(companyId, constant, cityData);
  await q(
    `INSERT INTO companies
       (company_id, name, logo_url, avg_score, feedback_value, feedback_number,
        awarded, price_category, delivery_on_saturday, delivery_on_sunday,
        menu_enabled, menu_days_ahead, orders_enabled, delivery_enabled)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
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
    ]
  );

  await q(
    `INSERT INTO company_snapshots (company_id, avg_score, feedback_value, feedback_number, awarded, price_category)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      companyId,
      r.rateValue,
      r.feedbackValue,
      r.feedbackNumber,
      r.awarded,
      r.priceCategory,
    ]
  );
};

const upsertCompanyCity = async (
  companyId: string,
  cityId: number,
  cityData: CityResponse
): Promise<void> => {
  const lp = cityData.lowestPrice;
  await q(
    `INSERT INTO company_cities (company_id, city_id, delivery_fee, lowest_price_standard, lowest_price_menu_config)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (company_id, city_id) DO UPDATE SET
       delivery_fee             = EXCLUDED.delivery_fee,
       lowest_price_standard    = EXCLUDED.lowest_price_standard,
       lowest_price_menu_config = EXCLUDED.lowest_price_menu_config,
       updated_at               = NOW()`,
    [
      companyId,
      cityId,
      cityData.citySearchResult.deliveryFee ?? null,
      parsePrice(lp.standard),
      parsePrice(lp.menuConfiguration),
    ]
  );
};

const upsertDiet = async (companyId: string, diet: Diet): Promise<void> => {
  await q(
    `INSERT INTO diets
       (diet_id, company_id, name, description, image_url, awarded, avg_score,
        feedback_value, feedback_number, diet_tag, is_menu_configuration, diet_meal_count, valid_from)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
     ON CONFLICT (diet_id, company_id) DO UPDATE SET
       name                  = EXCLUDED.name,
       description           = EXCLUDED.description,
       avg_score             = EXCLUDED.avg_score,
       feedback_value        = EXCLUDED.feedback_value,
       feedback_number       = EXCLUDED.feedback_number,
       is_menu_configuration = EXCLUDED.is_menu_configuration,
       diet_meal_count       = EXCLUDED.diet_meal_count,
       valid_to              = NULL,
       updated_at            = NOW()`,
    [
      diet.dietId,
      companyId,
      diet.name,
      diet.description ?? null,
      diet.imageUrl ?? null,
      diet.awarded ?? false,
      diet.avgScore ?? null,
      diet.feedbackValue ?? null,
      diet.feedbackNumber ?? null,
      diet.dietTag ?? null,
      diet.isMenuConfiguration ?? false,
      diet.dietMealCount ?? null,
    ]
  );

  await q(`DELETE FROM diet_discounts WHERE diet_id=$1 AND company_id=$2`, [
    diet.dietId,
    companyId,
  ]);
  for (const d of diet.discounts ?? []) {
    await q(
      `INSERT INTO diet_discounts (diet_id, company_id, discount, minimum_days, discount_type)
       VALUES ($1,$2,$3,$4,$5)`,
      [diet.dietId, companyId, d.discount, d.minimumDays, d.discountType]
    );
  }
};

const upsertTier = async (
  companyId: string,
  dietId: number,
  tier: Tier
): Promise<void> => {
  await q(
    `INSERT INTO tiers (tier_id, diet_id, company_id, name, min_price, meals_number, default_option_change, tag, valid_from)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
     ON CONFLICT (tier_id, diet_id, company_id) DO UPDATE SET
       name                  = EXCLUDED.name,
       min_price             = EXCLUDED.min_price,
       meals_number          = EXCLUDED.meals_number,
       default_option_change = EXCLUDED.default_option_change,
       tag                   = EXCLUDED.tag,
       valid_to              = NULL,
       updated_at            = NOW()`,
    [
      tier.tierId,
      dietId,
      companyId,
      tier.name,
      parsePrice(tier.minPrice),
      tier.mealsNumber ?? null,
      tier.defaultOptionChange ?? false,
      tier.tag ?? null,
    ]
  );
};

/**
 * Upsert one (company, diet, kcal_id, tier|null, option|null) row.
 * Uses the v4 composite unique index. Two-phase update-or-insert because the
 * index has COALESCE() expressions (NULL-safe), which ON CONFLICT can match
 * but only with the same expressions — easier to do explicitly in two steps.
 */
const upsertDietCalories = async (
  companyId: string,
  dietId: number,
  dietCaloriesId: number,
  calories: number | null,
  tierId: number | null,
  dietOptionId: number | null
): Promise<void> => {
  const upd = await q(
    `UPDATE diet_calories
        SET calories   = COALESCE($5::numeric, calories),
            valid_to   = NULL,
            updated_at = NOW()
      WHERE company_id = $1
        AND diet_id    = $2
        AND diet_calories_id = $3
        AND COALESCE(tier_id, -1)        = COALESCE($4::int, -1)
        AND COALESCE(diet_option_id, -1) = COALESCE($6::int, -1)`,
    [companyId, dietId, dietCaloriesId, tierId, calories, dietOptionId]
  );
  if (upd.rowCount !== null && upd.rowCount > 0) {
    return;
  }
  await q(
    `INSERT INTO diet_calories
       (diet_calories_id, diet_option_id, tier_id, diet_id, company_id, calories, valid_from)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT DO NOTHING`,
    [dietCaloriesId, dietOptionId, tierId, dietId, companyId, calories]
  );
};

const upsertOption = async (
  companyId: string,
  dietId: number,
  tierId: number,
  opt: DietOption
): Promise<void> => {
  await q(
    `INSERT INTO diet_options
       (diet_option_id, tier_id, diet_id, company_id, tier_diet_option_id, name, diet_option_tag, is_default, valid_from)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
     ON CONFLICT (diet_option_id, tier_id, diet_id, company_id) DO UPDATE SET
       name            = EXCLUDED.name,
       diet_option_tag = EXCLUDED.diet_option_tag,
       is_default      = EXCLUDED.is_default,
       valid_to        = NULL,
       updated_at      = NOW()`,
    [
      opt.dietOptionId,
      tierId,
      dietId,
      companyId,
      opt.tierDietOptionId ?? null,
      opt.name,
      opt.dietOptionTag ?? null,
      opt.defaultOption ?? false,
    ]
  );

  for (const cal of opt.dietCalories ?? []) {
    await upsertDietCalories(
      companyId,
      dietId,
      cal.dietCaloriesId,
      cal.calories,
      tierId,
      opt.dietOptionId
    );
  }
};

// ── main export ───────────────────────────────────────────────────────────────

export const scrapeCatalog = async (
  companyId: string,
  cityId: number
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

  await upsertCompany(companyId, constant, cityData);
  await upsertCompanyCity(companyId, cityId, cityData);

  // dietPriceInfo gives kcal IDs for all diets (used for "ready"/non-tiered diets)
  const dietPriceMap = new Map(
    (cityData.dietPriceInfo ?? []).map((p) => [p.dietId, p.dietCaloriesIds])
  );

  const activeDietIds: number[] = [];
  let totalCalories = 0;

  for (const diet of constant.companyDiets ?? []) {
    await upsertDiet(companyId, diet);
    activeDietIds.push(diet.dietId);

    if ((diet.dietTiers ?? []).length > 0) {
      // Tiered diet: full tree from /constant
      for (const tier of diet.dietTiers) {
        await upsertTier(companyId, diet.dietId, tier);
        for (const opt of tier.dietOptions ?? []) {
          await upsertOption(companyId, diet.dietId, tier.tierId, opt);
          totalCalories += opt.dietCalories?.length ?? 0;
        }
      }
    } else {
      // Ready / flat diet: prefer /constant dietOptions (has calories number),
      // fall back to /city dietPriceInfo (id list only).
      const fromConstant = (diet.dietOptions ?? []).flatMap((o) =>
        (o.dietCalories ?? []).map((c) => ({
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
        await upsertDietCalories(
          companyId,
          diet.dietId,
          calId,
          calories,
          null,
          null
        );
        totalCalories += 1;
      }
    }
  }

  // Mark catalog items no longer returned by the API as inactive
  if (activeDietIds.length > 0) {
    await q(
      `UPDATE diets SET valid_to = NOW()
       WHERE company_id = $1 AND valid_to IS NULL AND diet_id != ALL($2)`,
      [companyId, activeDietIds]
    );
  }

  // Persist any active promo info from the company header at catalog time —
  // ensures partial / single-company runs still get current promo data without
  // waiting for the end-of-run scrapePromotions pass.
  try {
    const { recordPromosFromConstants } = await import("./promotions.js");
    await recordPromosFromConstants(cityId, [{ companyId, constant }]);
  } catch (error) {
    console.warn(`[catalog] promo write skipped (${errMessage(error)})`);
  }

  console.log(
    `[catalog] ✓ ${companyId}: ${activeDietIds.length} diets, ${totalCalories} kcal nodes`
  );
};
