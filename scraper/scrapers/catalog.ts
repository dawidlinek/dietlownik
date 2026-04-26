import { get, parsePrice } from '../api.js';
import { q } from '../db.js';
import type {
  ConstantResponse, CityResponse, Diet, Tier, DietOption,
} from '../types.js';

// ── helpers ───────────────────────────────────────────────────────────────────

async function upsertCompany(
  companyId: string,
  constant: ConstantResponse,
  cityData: CityResponse,
): Promise<void> {
  const { companyHeader: h, companyParams: p, menuSettings: m } = constant;
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
      companyId, h?.name ?? companyId, h?.logoUrl ?? null,
      h?.avgScore ?? null, h?.feedbackValue ?? null, h?.feedbackNumber ?? null,
      h?.awarded ?? false, cityData?.companyPriceCategory ?? null,
      p?.deliveryOnSaturday ?? null, p?.deliveryOnSunday ?? null,
      m?.menuEnabled ?? null, m?.menuDaysAhead ?? null,
      cityData?.companySettings?.ordersEnabled ?? null,
      cityData?.companySettings?.deliveryEnabled ?? null,
    ],
  );

  await q(
    `INSERT INTO company_snapshots (company_id, avg_score, feedback_value, feedback_number, awarded, price_category)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      companyId, h?.avgScore ?? null, h?.feedbackValue ?? null,
      h?.feedbackNumber ?? null, h?.awarded ?? false,
      cityData?.companyPriceCategory ?? null,
    ],
  );
}

async function upsertCompanyCity(
  companyId: string, cityId: number, cityData: CityResponse,
): Promise<void> {
  const lp = cityData?.lowestPrice ?? {};
  await q(
    `INSERT INTO company_cities (company_id, city_id, delivery_fee, lowest_price_standard, lowest_price_menu_config)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (company_id, city_id) DO UPDATE SET
       delivery_fee             = EXCLUDED.delivery_fee,
       lowest_price_standard    = EXCLUDED.lowest_price_standard,
       lowest_price_menu_config = EXCLUDED.lowest_price_menu_config,
       updated_at               = NOW()`,
    [
      companyId, cityId,
      cityData?.citySearchResult?.deliveryFee ?? null,
      parsePrice(lp.standard), parsePrice(lp.menuConfiguration),
    ],
  );
}

async function upsertDiet(companyId: string, diet: Diet): Promise<void> {
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
      diet.dietId, companyId, diet.name, diet.description ?? null, diet.imageUrl ?? null,
      diet.awarded ?? false, diet.avgScore ?? null, diet.feedbackValue ?? null,
      diet.feedbackNumber ?? null, diet.dietTag ?? null,
      diet.isMenuConfiguration ?? false, diet.dietMealCount ?? null,
    ],
  );

  await q(`DELETE FROM diet_discounts WHERE diet_id=$1 AND company_id=$2`, [diet.dietId, companyId]);
  for (const d of diet.discounts ?? []) {
    await q(
      `INSERT INTO diet_discounts (diet_id, company_id, discount, minimum_days, discount_type)
       VALUES ($1,$2,$3,$4,$5)`,
      [diet.dietId, companyId, d.discount, d.minimumDays, d.discountType],
    );
  }
}

async function upsertTier(companyId: string, dietId: number, tier: Tier): Promise<void> {
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
      tier.tierId, dietId, companyId, tier.name,
      parsePrice(tier.minPrice), tier.mealsNumber ?? null,
      tier.defaultOptionChange ?? false, tier.tag ?? null,
    ],
  );
}

async function upsertOption(
  companyId: string, dietId: number, tierId: number, opt: DietOption,
): Promise<void> {
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
      opt.dietOptionId, tierId, dietId, companyId,
      opt.tierDietOptionId ?? null, opt.name,
      opt.dietOptionTag ?? null, opt.defaultOption ?? false,
    ],
  );

  for (const cal of opt.dietCalories ?? []) {
    await q(
      `INSERT INTO diet_calories (diet_calories_id, diet_option_id, tier_id, diet_id, company_id, calories, valid_from)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (diet_calories_id) DO UPDATE SET
         calories   = EXCLUDED.calories,
         valid_to   = NULL,
         updated_at = NOW()`,
      [cal.dietCaloriesId, opt.dietOptionId, tierId, dietId, companyId, cal.calories],
    );
  }
}

// ── main export ───────────────────────────────────────────────────────────────

export async function scrapeCatalog(companyId: string, cityId: number): Promise<void> {
  console.log(`[catalog] ${companyId} / city=${cityId}`);

  const [constant, cityData] = await Promise.all([
    get<ConstantResponse>(`/api/dietly/open/company-card/${companyId}/constant?cityId=${cityId}`, { companyId }),
    get<CityResponse>(`/api/dietly/open/company-card/${companyId}/city/${cityId}`, { companyId }),
  ]);

  await upsertCompany(companyId, constant, cityData);
  await upsertCompanyCity(companyId, cityId, cityData);

  const activeDietIds: number[] = [];

  for (const diet of constant.companyDiets ?? []) {
    await upsertDiet(companyId, diet);
    activeDietIds.push(diet.dietId);

    for (const tier of diet.dietTiers ?? []) {
      await upsertTier(companyId, diet.dietId, tier);
      for (const opt of tier.dietOptions ?? []) {
        await upsertOption(companyId, diet.dietId, tier.tierId, opt);
      }
    }
  }

  // Mark catalog items no longer returned by the API as inactive
  if (activeDietIds.length > 0) {
    await q(
      `UPDATE diets SET valid_to = NOW()
       WHERE company_id = $1 AND valid_to IS NULL AND diet_id != ALL($2)`,
      [companyId, activeDietIds],
    );
  }

  const totalCalories = (constant.companyDiets ?? []).reduce(
    (s, d) => s + (d.dietTiers ?? []).reduce(
      (s2, t) => s2 + (t.dietOptions ?? []).reduce((s3, o) => s3 + (o.dietCalories ?? []).length, 0),
      0,
    ),
    0,
  );

  console.log(`[catalog] ✓ ${companyId}: ${activeDietIds.length} diets, ${totalCalories} kcal nodes`);
}
