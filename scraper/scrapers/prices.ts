import { post, futureWeekdays } from '../api.js';
import { q } from '../db.js';
import type { PriceRequestBody, PriceResponse, PriceLeaf } from '../types.js';

const ORDER_DAY_TIERS = [5, 10, 20];
const CONCURRENCY = 8;

async function getLeaves(companyId: string): Promise<PriceLeaf[]> {
  const { rows } = await q<PriceLeaf>(
    `SELECT
       dc.diet_calories_id,
       dc.diet_id,
       dc.tier_id,
       do2.tier_diet_option_id,
       d.is_menu_configuration,
       co.delivery_on_saturday
     FROM diet_calories dc
     LEFT JOIN diet_options do2
       ON do2.diet_option_id = dc.diet_option_id
      AND do2.tier_id        = dc.tier_id
      AND do2.diet_id        = dc.diet_id
      AND do2.company_id     = dc.company_id
     JOIN diets d
       ON d.diet_id    = dc.diet_id
      AND d.company_id = dc.company_id
     JOIN companies co ON co.company_id = dc.company_id
     WHERE dc.company_id = $1
       AND dc.valid_to IS NULL
       AND d.valid_to   IS NULL
       AND (dc.diet_option_id IS NULL OR do2.valid_to IS NULL)`,
    [companyId],
  );
  return rows;
}

// (leaf, days) pairs — the unit of work
interface PriceJob {
  leaf: PriceLeaf;
  days: number;
  deliveryDates: string[];
}

async function fetchAndInsert(
  job: PriceJob,
  companyId: string,
  cityId: number,
): Promise<boolean> {
  const { leaf, days, deliveryDates } = job;

  const body: PriceRequestBody = {
    promoCodes: [],
    deliveryDates,
    dietCaloriesId: leaf.diet_calories_id,
    testOrder: false,
    cityId,
    ...(leaf.is_menu_configuration && leaf.tier_diet_option_id
      ? { tierDietOptionId: leaf.tier_diet_option_id }
      : {}),
  };

  let result: PriceResponse;
  try {
    result = await post<PriceResponse>(
      `/api/dietly/open/company-card/${companyId}/quick-order/calculate-price`,
      body,
      { companyId },
    );
  } catch (err) {
    console.warn(
      `[prices] skip cal=${leaf.diet_calories_id} days=${days}: ${(err as Error).message}`,
    );
    return false;
  }

  const cart = result.cart ?? {};
  const item = result.items?.[0] ?? {};

  await q(
    `INSERT INTO prices
       (diet_calories_id, company_id, city_id, tier_diet_option_id, order_days, promo_codes,
        per_day_cost, per_day_cost_with_discounts,
        total_cost, total_cost_without_discounts,
        total_delivery_cost, total_order_length_discount,
        total_promo_code_discount, total_delivery_discount)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      leaf.diet_calories_id, companyId, cityId,
      leaf.tier_diet_option_id ?? null,
      days, [],
      item.perDayDietCost ?? null,
      item.perDayDietWithDiscountsCost ?? null,
      cart.totalCostToPay ?? null,
      cart.totalCostWithoutDiscounts ?? null,
      cart.totalDeliveryCost ?? null,
      cart.totalOrderLengthDiscount ?? null,
      cart.totalPromoCodeDiscount ?? null,
      cart.totalDeliveriesOnDateDiscount ?? null,
    ],
  );

  return true;
}

async function runConcurrent(
  jobs: PriceJob[],
  companyId: string,
  cityId: number,
): Promise<number> {
  let inserted = 0;
  const queue = [...jobs];

  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length > 0) {
        const job = queue.shift()!;
        if (await fetchAndInsert(job, companyId, cityId)) inserted++;
      }
    }),
  );

  return inserted;
}

export async function scrapePrices(companyId: string, cityId: number): Promise<void> {
  console.log(`[prices] ${companyId} / city=${cityId}`);
  const leaves = await getLeaves(companyId);

  if (leaves.length === 0) {
    console.log(`[prices] no active leaves for ${companyId}, skipping`);
    return;
  }

  const includeSaturday = leaves[0]?.delivery_on_saturday ?? false;

  // Pre-compute delivery date arrays once per order length
  const datesByDays = Object.fromEntries(
    ORDER_DAY_TIERS.map(days => [days, futureWeekdays(days, { includeSaturday })]),
  );

  const jobs: PriceJob[] = leaves.flatMap(leaf =>
    ORDER_DAY_TIERS.map(days => ({ leaf, days, deliveryDates: datesByDays[days] })),
  );

  const t0 = Date.now();
  const inserted = await runConcurrent(jobs, companyId, cityId);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`[prices] ✓ ${companyId}: ${inserted}/${jobs.length} rows inserted (${elapsed}s)`);
}
