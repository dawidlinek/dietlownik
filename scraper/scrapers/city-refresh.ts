// City refresh — the per-city half of the national scrape.
//
// For one tracked city:
//   1. GET awarded-and-top (one page)      → cities row + which caterings
//                                            deliver here (company_cities)
//   2. per listed catering:
//      GET /company-card/{slug}/city/{id}  → delivery fee, "from" prices,
//                                            switches, windows
//                                            (company_cities + history) and
//                                            advertised diet prices
//                                            (diet_advertised_prices)
//   3. caterings the listing no longer includes are deactivated, and their
//      open per-city spans closed.
//
// Catalog, menus and quotes are NOT fetched here: they are the same in every
// city and come from the catering's home city (scraper/index.ts). The
// advertised prices collected here are what decides whether a city can
// borrow the home city's quotes (scraper/scrapers/price-groups.ts).
//
// ~1 + (caterings in the city) requests: ~150 for a large city.

import { get } from "../api";
import { q } from "../db";
import { getCurrentRunId, recordScrapeError } from "../scrape-run";
import type { CityResponse, CompanySearchItem, DeepReadonly } from "../types";
import { upsertCompanyCity } from "./catalog";
import { recordAdvertisedPrices } from "./catalog-extras";
import { upsertCity } from "./city";
import { fetchCityListing } from "./companies";

const PER_CITY_CONCURRENCY = 4;

export interface CityRefreshResult {
  readonly cityId: number;
  readonly name: string;
  readonly listed: number;
  readonly refreshed: number;
  readonly failed: number;
  readonly deactivated: number;
  /** The listing, for search-only catering fields and promotions. */
  readonly items: readonly CompanySearchItem[];
}

/**
 * Record the listing as memberships in one statement. A catering the
 * database has never seen gets a stub companies row (name only) so the
 * membership can reference it; the national pass fills it in.
 */
const recordMemberships = async (
  cityId: number,
  items: readonly DeepReadonly<CompanySearchItem>[]
): Promise<void> => {
  const ids = items.map((c) => c.name);
  await q(
    `INSERT INTO companies (company_id, name)
     SELECT id, name FROM unnest($1::text[], $2::text[]) AS t(id, name)
     ON CONFLICT (company_id) DO NOTHING`,
    [ids, items.map((c) => c.fullName ?? c.name)]
  );
  await q(
    `INSERT INTO company_cities (company_id, city_id, order_possible_on, order_possible_to)
     SELECT id, $1, on_date, to_ts
       FROM unnest($2::text[], $3::date[], $4::timestamptz[]) AS t(id, on_date, to_ts)
     ON CONFLICT (company_id, city_id) DO UPDATE SET
       is_active         = TRUE,
       last_seen_at      = NOW(),
       order_possible_on = EXCLUDED.order_possible_on,
       order_possible_to = EXCLUDED.order_possible_to`,
    [
      cityId,
      ids,
      items.map((c) => c.orderPossibleOn ?? null),
      items.map((c) => c.orderPossibleTo ?? null),
    ]
  );
};

/**
 * Deactivate memberships the listing no longer includes and close their open
 * per-city spans (terms and advertised prices): a successful, complete
 * listing without them is the observation that they ended.
 */
const deactivateMissing = async (
  cityId: number,
  listed: readonly string[]
): Promise<number> => {
  const { rows } = await q<{ n: string }>(
    `WITH gone AS (
       UPDATE company_cities SET is_active = FALSE
        WHERE city_id = $1 AND is_active AND company_id <> ALL ($2::text[])
       RETURNING company_id
     ),
     terms AS (
       UPDATE company_city_history h SET closed_at = NOW()
         FROM gone
        WHERE h.company_id = gone.company_id AND h.city_id = $1
          AND h.closed_at IS NULL
       RETURNING 1
     ),
     advertised AS (
       UPDATE diet_advertised_prices a SET closed_at = NOW()
         FROM gone
        WHERE a.company_id = gone.company_id AND a.city_id = $1
          AND a.closed_at IS NULL
       RETURNING 1
     )
     SELECT count(*)::text AS n FROM gone`,
    [cityId, listed]
  );
  return Number(rows[0]?.n ?? 0);
};

/** /city for one catering in one city → terms + advertised prices. */
const refreshTerms = async (
  cityId: number,
  item: DeepReadonly<CompanySearchItem>
): Promise<boolean> => {
  const companyId = item.name;
  try {
    const data = await get<CityResponse>(
      `/api/mobile/open/company-card/${companyId}/city/${cityId}`,
      { companyId }
    );
    await upsertCompanyCity(companyId, cityId, data, item);
    await recordAdvertisedPrices(companyId, cityId, data.dietPriceInfo ?? []);
    return true;
  } catch (error) {
    await recordScrapeError(getCurrentRunId(), "city-refresh", {
      companyId,
      context: `city=${cityId}`,
      error,
    });
    return false;
  }
};

export const refreshCity = async (
  cityId: number,
  name: string
): Promise<CityRefreshResult> => {
  const t0 = Date.now();
  const listing = await fetchCityListing(cityId);
  if (listing.city !== null) {
    await upsertCity(listing.city);
  }
  const { items } = listing;
  // An empty or short listing is not evidence that caterings left: keep the
  // memberships as they are and try again next run.
  const complete = items.length > 0 && items.length >= listing.total;
  await recordMemberships(cityId, items);

  let refreshed = 0;
  let failed = 0;
  const queue = [...items];
  await Promise.all(
    Array.from({ length: PER_CITY_CONCURRENCY }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
        if (await refreshTerms(cityId, item)) {
          refreshed += 1;
        } else {
          failed += 1;
        }
      }
    })
  );

  const deactivated = complete
    ? await deactivateMissing(
        cityId,
        items.map((c: DeepReadonly<CompanySearchItem>) => c.name)
      )
    : 0;
  if (complete) {
    await q(`UPDATE cities SET last_refreshed_at = NOW() WHERE city_id = $1`, [
      cityId,
    ]);
  } else {
    console.warn(
      `[city-refresh] ${name}: listing incomplete (${items.length}/${listing.total}), memberships kept`
    );
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[city-refresh] ✓ ${name} (${cityId}): ${items.length} caterings, ${refreshed} terms refreshed${failed > 0 ? `, ${failed} failed` : ""}${deactivated > 0 ? `, ${deactivated} left` : ""} (${elapsed}s)`
  );
  return {
    cityId,
    deactivated,
    failed,
    items,
    listed: items.length,
    name,
    refreshed,
  };
};
