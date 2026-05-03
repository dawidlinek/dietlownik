// Backfill: quote each catering's leaves with its active promo code(s).
//
// The regular price scrape only quotes promoCodes=[] (order-length-only).
// The dashboard's cheapest-pick across the (company, leaf, days) tuple
// expects with-code rows to live alongside the no-code rows so it can
// surface whichever price is genuinely lower.
//
// This script walks every company that currently has an active code in
// `campaigns`, loads its active leaves from `diet_calories`, and runs the
// with-code quotes only — no-code rows already exist from the regular
// scrape (verify before running). Same rate-limited HTTP client and
// per-request `company-id` header path as the main scraper, so it shares
// the global limiter cleanly with any in-flight work.
//
// Tunables: MAX_IN_FLIGHT (api.ts) governs the global concurrency cap;
// CITY (default Wrocław) selects the city used in calculate-price calls.

import { get, futureWeekdays } from "../api";
import { pool, q } from "../db";
import {
  getLeaves,
  getActivePromoCodes,
  fetchAndInsert,
  runConcurrent,
  ORDER_DAY_TIERS,
} from "../scrapers/prices";
import type { PriceJob } from "../scrapers/prices";
import type { City, DeepReadonly, PriceLeaf } from "../types";

const CITY_NAME = process.env.CITY ?? "Wrocław";
const COMPANY_FILTER = process.env.COMPANY ?? null;
// Per-company concurrency for the in-script worker pool. The shared limiter
// in api.ts (MAX_IN_FLIGHT) is the actual ceiling; this just bounds the
// number of jobs we hand to it at once.
const PER_COMPANY_CONCURRENCY = Number(
  process.env.PER_COMPANY_CONCURRENCY ?? 4
);

interface TopSearchResponse {
  cities: City[];
}

const errMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const resolveCity = async (name: string): Promise<City> => {
  const data = await get<TopSearchResponse>(
    `/api/open/search/top-search?query=${encodeURIComponent(name)}&citiesSize=10&companiesSize=0`
  );
  const c =
    data.cities.find(
      (x: Readonly<City>) => x.name.toLowerCase() === name.toLowerCase()
    ) ?? data.cities[0];
  if (c === undefined) {
    throw new Error(`No city matched "${name}"`);
  }
  return c;
};

interface CompanyTarget {
  companyId: string;
  codes: string[];
}

const listTargets = async (): Promise<CompanyTarget[]> => {
  const { rows } = await q<{ company_id: string; codes: string[] }>(
    `SELECT company_id, ARRAY_AGG(DISTINCT code) AS codes
       FROM campaigns
      WHERE is_active = TRUE
        AND company_id IS NOT NULL
        AND (deadline IS NULL OR deadline >= CURRENT_DATE)
        AND (valid_to IS NULL OR valid_to >= NOW())
      GROUP BY company_id
      ORDER BY company_id`
  );
  const filterStr = COMPANY_FILTER ?? "";
  return rows
    .map((r: Readonly<{ company_id: string; codes: readonly string[] }>) => ({
      codes: [...(r.codes ?? [])],
      companyId: r.company_id,
    }))
    .filter(
      (t: DeepReadonly<CompanyTarget>) =>
        filterStr === "" || t.companyId === filterStr
    );
};

interface CompanyResult {
  companyId: string;
  leavesQuoted: number;
  rowsInserted: number;
  jobs: number;
  codes: string[];
  noCodeRowsRecent: number;
}

const processCompany = async (
  target: DeepReadonly<CompanyTarget>,
  cityId: number
): Promise<CompanyResult> => {
  const { companyId } = target;

  // Pull canonical, deduped, trimmed list — same logic the regular scraper
  // will use, so we don't fight that path on case/whitespace edge cases.
  const codes = await getActivePromoCodes(companyId);
  if (codes.length === 0) {
    return {
      codes: [],
      companyId,
      jobs: 0,
      leavesQuoted: 0,
      noCodeRowsRecent: 0,
      rowsInserted: 0,
    };
  }

  const leaves = await getLeaves(companyId);
  if (leaves.length === 0) {
    console.warn(`[promo-prices] ${companyId}: no active leaves, skipping`);
    return {
      codes,
      companyId,
      jobs: 0,
      leavesQuoted: 0,
      noCodeRowsRecent: 0,
      rowsInserted: 0,
    };
  }

  // Sanity check: confirm the regular scrape already covered this company
  // with no-code rows recently. The instruction is to run with-code only —
  // if no-code is missing, surface a warning instead of silently producing
  // half-coverage rows.
  const { rows: cov } = await q<{ recent: number }>(
    `SELECT COUNT(*)::int AS recent FROM prices
      WHERE company_id = $1
        AND promo_codes = '{}'
        AND captured_at > NOW() - INTERVAL '6 hours'`,
    [companyId]
  );
  const noCodeRowsRecent = cov[0]?.recent ?? 0;
  if (noCodeRowsRecent === 0) {
    console.warn(
      `[promo-prices] ${companyId}: WARNING no recent (<6h) no-code rows — backfill will still run, but the dashboard's cheapest-pick may be lopsided until the regular scrape catches up.`
    );
  }

  const includeSaturday = leaves[0]?.delivery_on_saturday ?? false;
  const includeSunday = leaves[0]?.delivery_on_sunday ?? false;

  const datesByDays = Object.fromEntries(
    ORDER_DAY_TIERS.map((days) => [
      days,
      futureWeekdays(days, { includeSaturday, includeSunday }),
    ])
  );

  // With-code only: skip promoCodes=[].
  const jobs: PriceJob[] = leaves.flatMap((leaf: DeepReadonly<PriceLeaf>) =>
    ORDER_DAY_TIERS.flatMap((days) =>
      codes.map((code) => ({
        days,
        deliveryDates: datesByDays[days],
        leaf,
        promoCodes: [code],
      }))
    )
  );

  console.log(
    `[promo-prices] ${companyId}: leaves=${leaves.length} codes=${codes.join(",")} jobs=${jobs.length} (no-code recent=${noCodeRowsRecent})`
  );

  const t0 = Date.now();
  const inserted = await runConcurrent(
    jobs,
    companyId,
    cityId,
    PER_COMPANY_CONCURRENCY
  );
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(
    `[promo-prices] ✓ ${companyId}: ${inserted}/${jobs.length} rows in ${elapsed}s`
  );

  return {
    codes,
    companyId,
    jobs: jobs.length,
    leavesQuoted: leaves.length,
    noCodeRowsRecent,
    rowsInserted: inserted,
  };
};

const run = async (): Promise<void> => {
  console.log(`[promo-prices] resolving city ${CITY_NAME}…`);
  const city = await resolveCity(CITY_NAME);
  console.log(`[promo-prices] cityId=${city.cityId}`);

  const targets = await listTargets();
  console.log(`[promo-prices] ${targets.length} companies with active codes`);

  if (targets.length === 0) {
    console.log("[promo-prices] nothing to do");
    await pool.end();
    return;
  }

  // Suppress unused-import noise: keep `fetchAndInsert` available to callers
  // who might want a single-quote variant later. Reference it once.
  void fetchAndInsert;

  const t0 = Date.now();
  const results: CompanyResult[] = [];
  // Sequential per-company, parallel within each — the api.ts limiter caps
  // global concurrency, but pacing one company at a time keeps log output
  // readable and gives the in-flight scrape predictable headroom.
  for (let i = 0; i < targets.length; i += 1) {
    const t = targets[i];
    console.log(`\n[promo-prices] (${i + 1}/${targets.length}) ${t.companyId}`);
    try {
      results.push(await processCompany(t, city.cityId));
    } catch (error) {
      console.error(
        `[promo-prices] ${t.companyId}: fatal: ${errMessage(error)}`
      );
      results.push({
        codes: t.codes,
        companyId: t.companyId,
        jobs: 0,
        leavesQuoted: 0,
        noCodeRowsRecent: 0,
        rowsInserted: 0,
      });
    }
  }

  const totalLeaves = results.reduce(
    (s, r: DeepReadonly<CompanyResult>) => s + r.leavesQuoted,
    0
  );
  const totalInserted = results.reduce(
    (s, r: DeepReadonly<CompanyResult>) => s + r.rowsInserted,
    0
  );
  const totalJobs = results.reduce(
    (s, r: DeepReadonly<CompanyResult>) => s + r.jobs,
    0
  );
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log("\n[promo-prices] ── summary ──");
  console.log(`  city:               ${CITY_NAME} (${city.cityId})`);
  console.log(`  companies processed: ${results.length}`);
  console.log(`  leaves quoted:       ${totalLeaves}`);
  console.log(`  jobs attempted:      ${totalJobs}`);
  console.log(`  rows inserted:       ${totalInserted}`);
  console.log(`  failed jobs:         ${totalJobs - totalInserted}`);
  console.log(`  elapsed:             ${elapsed}s`);

  // Per-company breakdown for the few that failed every job.
  const allFailed = results.filter(
    (r: DeepReadonly<CompanyResult>) => r.jobs > 0 && r.rowsInserted === 0
  );
  if (allFailed.length > 0) {
    console.log(
      "\n[promo-prices] companies with 0 inserts (likely rejected codes):"
    );
    for (const r of allFailed) {
      console.log(
        `  - ${r.companyId} codes=${r.codes.join(",")} jobs=${r.jobs}`
      );
    }
  }

  await pool.end();
};

// oxlint-disable-next-line promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- top-level entry point
run().catch((error: unknown) => {
  console.error("[promo-prices] fatal:", error);
  process.exit(1);
});
