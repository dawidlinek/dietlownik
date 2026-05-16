import { get, parsePrice } from "../api";
import { q } from "../db";
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
  orderPossibleOn: string | null;
  orderPossibleTo: string | null;
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
    inviteCodeDiscountPercent: awardedExtras?.inviteCodeDiscountPercent ?? null,
    logoUrl: h.logoUrl ?? null,
    menuDaysAhead: m.menuDaysAhead ?? null,
    menuEnabled: m.menuEnabled ?? null,
    name: h.name ?? companyId,
    orderPossibleOn: awardedExtras?.orderPossibleOn ?? null,
    orderPossibleTo: awardedExtras?.orderPossibleTo ?? null,
    ordersEnabled: cityData.companySettings.ordersEnabled ?? null,
    priceCategory: cityData.companyPriceCategory ?? null,
    rateValue: h.rateValue ?? null,
    recentlyAdded: h.recentlyAdded ?? null,
  };
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
        invite_code_discount_percent, order_possible_on, order_possible_to)
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
       order_possible_on  = EXCLUDED.order_possible_on,
       order_possible_to  = EXCLUDED.order_possible_to,
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
      r.orderPossibleOn,
      r.orderPossibleTo,
    ]
  );

  await q(
    `INSERT INTO company_snapshots (
       company_id, avg_score, feedback_value, feedback_number, awarded, price_category,
       delivery_on_saturday, delivery_on_sunday, menu_enabled, menu_days_ahead,
       orders_enabled, delivery_enabled, logo_url,
       delivery_info_text, delivery_info_date, dietly_delivery, recently_added
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      companyId,
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
      r.logoUrl,
      r.deliveryInfoText,
      r.deliveryInfoDate,
      r.dietlyDelivery,
      r.recentlyAdded,
    ]
  );
};

const upsertCompanyCity = async (
  companyId: string,
  cityId: number,
  cityData: DeepReadonly<CityResponse>,
  awardedExtras: DeepReadonly<CompanySearchItem> | null
): Promise<void> => {
  const lp = cityData.lowestPrice;
  const standard = parsePrice(lp.standard);
  const menuConfig = parsePrice(lp.menuConfiguration);
  const deliveryFee = cityData.citySearchResult.deliveryFee ?? null;
  const ordersEnabled = cityData.companySettings.ordersEnabled ?? null;
  const deliveryEnabled = cityData.companySettings.deliveryEnabled ?? null;
  const inviteDiscount = awardedExtras?.inviteCodeDiscountPercent ?? null;
  const orderPossibleOn = awardedExtras?.orderPossibleOn ?? null;
  const orderPossibleTo = awardedExtras?.orderPossibleTo ?? null;

  await q(
    `INSERT INTO company_cities (company_id, city_id, delivery_fee, lowest_price_standard, lowest_price_menu_config)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (company_id, city_id) DO UPDATE SET
       delivery_fee             = EXCLUDED.delivery_fee,
       lowest_price_standard    = EXCLUDED.lowest_price_standard,
       lowest_price_menu_config = EXCLUDED.lowest_price_menu_config,
       updated_at               = NOW()`,
    [companyId, cityId, deliveryFee, standard, menuConfig]
  );

  await q(
    `INSERT INTO company_city_snapshots (
       company_id, city_id, delivery_fee, lowest_price_standard,
       lowest_price_menu_config, orders_enabled, delivery_enabled,
       invite_code_discount_percent, order_possible_on, order_possible_to
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      companyId,
      cityId,
      deliveryFee,
      standard,
      menuConfig,
      ordersEnabled,
      deliveryEnabled,
      inviteDiscount,
      orderPossibleOn,
      orderPossibleTo,
    ]
  );
};

const insertDietPriceInfo = async (
  companyId: string,
  cityId: number,
  cityData: DeepReadonly<CityResponse>
): Promise<void> => {
  for (const dpi of cityData.dietPriceInfo ?? []) {
    await q(
      `INSERT INTO diet_price_info_snapshots
         (company_id, city_id, diet_id, discount_price, default_price,
          diet_price_in_company_promotion, diet_calories_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        companyId,
        cityId,
        dpi.dietId,
        parsePrice(dpi.discountPrice),
        parsePrice(dpi.defaultPrice),
        dpi.dietPriceInCompanyPromotion ?? null,
        [...(dpi.dietCaloriesIds ?? [])],
      ]
    );
  }
};

/** Identity key for an order-length discount tier — see syncDietDiscounts. */
const discountKey = (
  d: Readonly<{
    minimum_days: number;
    discount_type: string;
    discount: number | string;
  }>
): string =>
  `${d.minimum_days}|${d.discount_type}|${Number(d.discount).toFixed(2)}`;

/**
 * SCD-merge the order-length discount ladder for a (diet, company).
 *
 *   - Rows in the API but not currently live → INSERT (valid_from=NOW).
 *   - Rows live in DB but missing from API   → UPDATE valid_to=NOW.
 *   - Rows that match an existing live row   → leave alone.
 *
 * Identity = (minimum_days, discount_type, discount). A reissued ladder with
 * the same shape never churns; a single curve change creates exactly one
 * expire-event and one insert-event.
 */
const syncDietDiscounts = async (
  companyId: string,
  dietId: number,
  apiDiscounts: readonly DeepReadonly<Discount>[]
): Promise<void> => {
  const { rows: live } = await q<{
    id: number;
    discount: string;
    minimum_days: number;
    discount_type: string;
  }>(
    `SELECT id, discount, minimum_days, discount_type
       FROM diet_discounts
      WHERE diet_id = $1 AND company_id = $2 AND valid_to IS NULL`,
    [dietId, companyId]
  );

  const liveByKey = new Map(
    live.map(
      (r: Readonly<(typeof live)[number]>) => [discountKey(r), r] as const
    )
  );
  const apiByKey = new Map(
    apiDiscounts.map(
      (d) =>
        [
          discountKey({
            discount: d.discount,
            discount_type: d.discountType,
            minimum_days: d.minimumDays,
          }),
          d,
        ] as const
    )
  );

  for (const [key, liveRow] of liveByKey) {
    if (!apiByKey.has(key)) {
      await q(`UPDATE diet_discounts SET valid_to = NOW() WHERE id = $1`, [
        liveRow.id,
      ]);
    }
  }
  for (const [key, apiRow] of apiByKey) {
    if (!liveByKey.has(key)) {
      await q(
        `INSERT INTO diet_discounts (diet_id, company_id, discount, minimum_days, discount_type, valid_from)
         VALUES ($1,$2,$3,$4,$5,NOW())`,
        [
          dietId,
          companyId,
          apiRow.discount,
          apiRow.minimumDays,
          apiRow.discountType,
        ]
      );
    }
  }
};

const upsertDiet = async (
  companyId: string,
  diet: DeepReadonly<Diet>
): Promise<void> => {
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

  await syncDietDiscounts(companyId, diet.dietId, diet.discounts ?? []);
};

const upsertTier = async (
  companyId: string,
  dietId: number,
  tier: DeepReadonly<Tier>
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
  opt: DeepReadonly<DietOption>
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

// ── expiry pass for missing sub-tree rows ─────────────────────────────────────

interface SeenSets {
  /** "diet_id" */
  diets: Set<number>;
  /** "diet_id|tier_id" */
  tiers: Set<string>;
  /** "diet_id|tier_id|option_id" */
  options: Set<string>;
  /** "diet_id|tier_id|option_id|diet_calories_id" */
  leaves: Set<string>;
}

const newSeen = (): SeenSets => ({
  diets: new Set(),
  leaves: new Set(),
  options: new Set(),
  tiers: new Set(),
});

const keyTier = (dietId: number, tierId: number | null): string =>
  `${dietId}|${tierId ?? -1}`;
const keyOption = (
  dietId: number,
  tierId: number | null,
  optionId: number | null
): string => `${dietId}|${tierId ?? -1}|${optionId ?? -1}`;
const keyLeaf = (
  dietId: number,
  tierId: number | null,
  optionId: number | null,
  leafId: number
): string => `${dietId}|${tierId ?? -1}|${optionId ?? -1}|${leafId}`;

/**
 * Mark every live row under `companyId` that the API no longer surfaced as
 * `valid_to = NOW()`. Mirrors the existing diets pass for the rest of the tree.
 * Order matters: leaves first, then options, then tiers, then diets (deepest
 * out). Each level's expiry is independent — a tier may stay but lose options.
 */
const expireMissing = async (
  companyId: string,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- DeepReadonly already covers SeenSets; rule has a false positive on the nested Set<> types
  seen: DeepReadonly<SeenSets>
): Promise<void> => {
  // diet_calories
  const { rows: liveLeaves } = await q<{
    id: number;
    diet_id: number;
    tier_id: number | null;
    diet_option_id: number | null;
    diet_calories_id: number;
  }>(
    `SELECT id, diet_id, tier_id, diet_option_id, diet_calories_id
       FROM diet_calories
      WHERE company_id = $1 AND valid_to IS NULL`,
    [companyId]
  );
  const leafIds: number[] = [];
  for (const r of liveLeaves) {
    const k = keyLeaf(
      r.diet_id,
      r.tier_id,
      r.diet_option_id,
      r.diet_calories_id
    );
    if (!seen.leaves.has(k)) {
      leafIds.push(r.id);
    }
  }
  if (leafIds.length > 0) {
    await q(
      `UPDATE diet_calories SET valid_to = NOW(), updated_at = NOW()
        WHERE id = ANY($1::bigint[])`,
      [leafIds]
    );
  }

  // diet_options
  const { rows: liveOpts } = await q<{
    id: number;
    diet_id: number;
    tier_id: number;
    diet_option_id: number;
  }>(
    `SELECT id, diet_id, tier_id, diet_option_id
       FROM diet_options
      WHERE company_id = $1 AND valid_to IS NULL`,
    [companyId]
  );
  const optIds: number[] = [];
  for (const r of liveOpts) {
    const k = keyOption(r.diet_id, r.tier_id, r.diet_option_id);
    if (!seen.options.has(k)) {
      optIds.push(r.id);
    }
  }
  if (optIds.length > 0) {
    await q(
      `UPDATE diet_options SET valid_to = NOW(), updated_at = NOW()
        WHERE id = ANY($1::int[])`,
      [optIds]
    );
  }

  // tiers
  const { rows: liveTiers } = await q<{
    id: number;
    diet_id: number;
    tier_id: number;
  }>(
    `SELECT id, diet_id, tier_id
       FROM tiers
      WHERE company_id = $1 AND valid_to IS NULL`,
    [companyId]
  );
  const tierIds: number[] = [];
  for (const r of liveTiers) {
    const k = keyTier(r.diet_id, r.tier_id);
    if (!seen.tiers.has(k)) {
      tierIds.push(r.id);
    }
  }
  if (tierIds.length > 0) {
    await q(
      `UPDATE tiers SET valid_to = NOW(), updated_at = NOW()
        WHERE id = ANY($1::int[])`,
      [tierIds]
    );
  }

  // diets — moved here so all four levels follow the same pattern.
  await q(
    `UPDATE diets SET valid_to = NOW(), updated_at = NOW()
      WHERE company_id = $1 AND valid_to IS NULL AND diet_id != ALL($2::int[])`,
    [companyId, [...seen.diets]]
  );

  // Discounts under expired diets follow the same fate (kept consistent so
  // get-active-discount lookups don't surface ghosts).
  await q(
    `UPDATE diet_discounts dd
        SET valid_to = NOW()
       FROM diets d
      WHERE dd.diet_id = d.diet_id
        AND dd.company_id = d.company_id
        AND dd.company_id = $1
        AND dd.valid_to IS NULL
        AND d.valid_to IS NOT NULL`,
    [companyId]
  );
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
  await insertDietPriceInfo(companyId, cityId, cityData);

  // dietPriceInfo gives kcal IDs for all diets (used for "ready"/non-tiered diets)
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
            seen.leaves.add(
              keyLeaf(
                diet.dietId,
                tier.tierId,
                opt.dietOptionId,
                cal.dietCaloriesId
              )
            );
          }
          totalCalories += opt.dietCalories?.length ?? 0;
        }
      }
    } else {
      // Ready / flat diet: prefer /constant dietOptions (has calories number),
      // fall back to /city dietPriceInfo (id list only).
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
        await upsertDietCalories(
          companyId,
          diet.dietId,
          calId,
          calories,
          null,
          null
        );
        seen.leaves.add(keyLeaf(diet.dietId, null, null, calId));
        totalCalories += 1;
      }
    }
  }

  // Mark catalog items no longer returned by the API as inactive — full tree.
  if (seen.diets.size > 0) {
    await expireMissing(companyId, seen);
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
    `[catalog] ✓ ${companyId}: ${seen.diets.size} diets, ${totalCalories} kcal nodes`
  );
};
