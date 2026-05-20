import { post, futureWeekdays } from "../api";
import { q } from "../db";
import { recordScrapeError, getCurrentRunId } from "../scrape-run";
import type {
  DeepReadonly,
  PriceRequestBody,
  PriceResponse,
  PriceLeaf,
} from "../types";

// Order-length tiers to quote. Default: day-1 only — cuts prices volume by
// ~4× vs the legacy [1, 5, 10, 20] sweep, which is the single biggest scrape-
// time win short of buying proxies. Override via env when a one-off needs the
// longer-order discount snapshot, e.g. `ORDER_DAY_TIERS=1,5,10,20`.
const parseTiers = (raw: string | undefined): number[] => {
  if (raw === undefined || raw.trim() === "") {
    return [1];
  }
  return raw
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
};
const ORDER_DAY_TIERS = parseTiers(process.env.ORDER_DAY_TIERS);
// Internal price-job concurrency. Match the global limiter cap (MAX_IN_FLIGHT=3
// by default) so 8 workers don't pile up requests that all hit CF in a burst.
// Higher values added queueing pressure without unlocking throughput.
const CONCURRENCY = 3;

const errMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Active per-company promo codes from the campaigns table (mutable, no
 * history in the new schema). The mobile API doesn't stack promo-code with
 * order-length discounts — it picks whichever is bigger. So we quote each
 * leaf both with `[]` (order-length-only) and once per active code; the
 * dashboard's cheapest-pick per (company, leaf, days) takes care of the rest.
 *
 * Returns deduped, trimmed, non-empty codes. Comparison is case-insensitive.
 */
export const getActivePromoCodes = async (
  companyId: string
): Promise<string[]> => {
  const { rows } = await q<{ code: string | null }>(
    `SELECT DISTINCT code FROM campaigns
      WHERE is_active = TRUE
        AND company_id = $1
        AND (ends_at IS NULL OR ends_at >= CURRENT_DATE)`,
    [companyId]
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    const code = (r.code ?? "").trim();
    if (code === "") {
      continue;
    }
    const key = code.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(code);
  }
  return out;
};

const getLeaves = async (companyId: string): Promise<PriceLeaf[]> => {
  const { rows } = await q<PriceLeaf>(
    `SELECT
       dc.diet_calories_id,
       dc.diet_id,
       dc.tier_id,
       do2.tier_diet_option_id,
       d.is_menu_configuration,
       co.delivery_on_saturday,
       co.delivery_on_sunday
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
       AND dc.is_active = TRUE
       AND d.is_active  = TRUE
       AND (do2.is_active IS NULL OR do2.is_active = TRUE)`,
    [companyId]
  );
  return rows;
};

// (leaf, days, promoCodes) triples — the unit of work. promoCodes=[] is the
// order-length-only baseline; non-empty arrays are with-code variants.
interface PriceJob {
  leaf: PriceLeaf;
  days: number;
  deliveryDates: string[];
  promoCodes: string[];
}

/**
 * One quote → one row. Returns true on insert, false on any HTTP/API
 * failure. With-code failures are isolated: the no-code job is a separate
 * PriceJob, so its outcome is independent.
 */
// oxlint-disable-next-line eslint/complexity -- straight-line fetch + insert; one branch per quote column is the goal
export const fetchAndInsert = async (
  job: DeepReadonly<PriceJob>,
  companyId: string,
  cityId: number
): Promise<boolean> => {
  const { leaf, days, deliveryDates, promoCodes } = job;

  const tdoId = leaf.tier_diet_option_id;
  const includeTdo =
    leaf.is_menu_configuration && tdoId !== null && tdoId !== "";
  const body: PriceRequestBody = {
    cityId,
    deliveryDates: [...deliveryDates],
    dietCaloriesId: leaf.diet_calories_id,
    promoCodes: [...promoCodes],
    testOrder: false,
    ...(includeTdo && tdoId !== null ? { tierDietOptionId: tdoId } : {}),
  };

  let result: PriceResponse;
  try {
    result = await post<PriceResponse>(
      `/api/mobile/open/company-card/${companyId}/quick-order/calculate-price`,
      body,
      { companyId }
    );
  } catch (error) {
    const codeTag =
      promoCodes.length > 0 ? ` code=${promoCodes.join(",")}` : "";
    console.warn(
      `[prices] skip cal=${leaf.diet_calories_id} days=${days}${codeTag}: ${errMessage(error)}`
    );
    await recordScrapeError(getCurrentRunId(), "prices", {
      companyId,
      context: `cal=${leaf.diet_calories_id} days=${days}${codeTag}`,
      error,
    });
    return false;
  }

  const { cart } = result;
  const [item] = result.items;

  await q(
    `INSERT INTO prices
       (diet_calories_id, company_id, city_id, order_days, promo_codes,
        per_day_cost,
        total_cost, total_cost_without_discounts,
        total_lowest_30days_cost_without_discounts,
        total_delivery_cost, total_delivery_discount,
        total_promo_code_discount, total_promo_code_discount_info,
        total_order_length_discount, total_deliveries_on_date_discount,
        total_loyalty_points_discount, total_pickup_point_discount,
        total_one_time_side_orders_cost,
        total_awarded_loyalty_program_points,
        total_awarded_global_loyalty_program_points)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [
      leaf.diet_calories_id,
      companyId,
      cityId,
      days,
      promoCodes,
      // List per-day. Effective net per-day is derived at read time as
      // total_cost / order_days — the API's perDayDietWithDiscountsCost
      // doesn't include the promo discount (verified against live API
      // 2026-05-20), so we don't store a misleading "with discounts" column.
      item?.perDayDietCost ?? null,
      cart.totalCostToPay ?? null,
      cart.totalCostWithoutDiscounts ?? null,
      cart.totalLowest30DaysCostWithoutDiscounts ?? null,
      cart.totalDeliveryCost ?? null,
      // total_delivery_discount — no direct equivalent in the API response
      null,
      cart.totalPromoCodeDiscount ?? null,
      cart.totalPromoCodeDiscountInfo ?? null,
      cart.totalOrderLengthDiscount ?? null,
      cart.totalDeliveriesOnDateDiscount ?? null,
      cart.totalLoyaltyPointsDiscount ?? null,
      cart.totalPickupPointDiscount ?? null,
      cart.totalOneTimeSideOrdersCost ?? null,
      cart.totalAwardedLoyaltyProgramPoints ?? null,
      cart.totalAwardedGlobalLoyaltyProgramPoints ?? null,
    ]
  );

  return true;
};

const runConcurrent = async (
  jobs: readonly DeepReadonly<PriceJob>[],
  companyId: string,
  cityId: number,
  concurrency: number = CONCURRENCY
): Promise<number> => {
  let inserted = 0;
  const queue = [...jobs];

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (queue.length > 0) {
        const job = queue.shift();
        if (job === undefined) {
          break;
        }
        if (await fetchAndInsert(job, companyId, cityId)) {
          inserted += 1;
        }
      }
    })
  );

  return inserted;
};

export const scrapePrices = async (
  companyId: string,
  cityId: number
): Promise<void> => {
  console.log(`[prices] ${companyId} / city=${cityId}`);
  const leaves = await getLeaves(companyId);

  if (leaves.length === 0) {
    console.log(`[prices] no active leaves for ${companyId}, skipping`);
    return;
  }

  const codes = await getActivePromoCodes(companyId);
  if (codes.length > 0) {
    console.log(
      `[prices]   active codes for ${companyId}: ${codes.join(", ")}`
    );
  }

  const includeSaturday = leaves[0]?.delivery_on_saturday ?? false;
  const includeSunday = leaves[0]?.delivery_on_sunday ?? false;

  // Pre-compute delivery date arrays once per order length
  const datesByDays = Object.fromEntries(
    ORDER_DAY_TIERS.map((days) => [
      days,
      futureWeekdays(days, { includeSaturday, includeSunday }),
    ])
  );

  // For each (leaf, days), one no-code quote and one quote per active code.
  // The dashboard's cheapest-pick per (company, leaf, days) takes care of
  // selecting the winning row downstream.
  const promoVariants: string[][] = [[], ...codes.map((c) => [c])];
  const jobs: PriceJob[] = leaves.flatMap((leaf: DeepReadonly<PriceLeaf>) =>
    ORDER_DAY_TIERS.flatMap((days) =>
      promoVariants.map((promoCodes: readonly string[]) => ({
        days,
        deliveryDates: datesByDays[days],
        leaf,
        promoCodes: [...promoCodes],
      }))
    )
  );

  const t0 = Date.now();
  const inserted = await runConcurrent(jobs, companyId, cityId);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(
    `[prices] ✓ ${companyId}: ${inserted}/${jobs.length} rows inserted (${elapsed}s)`
  );
};

// Exported for the backfill script.
export { runConcurrent, getLeaves, ORDER_DAY_TIERS };
export type { PriceJob };
