// One-off: walk awarded-and-top + per-company /constant headers right now,
// persist whatever promo info is currently exposed by the API. Useful when
// you don't want to wait for the full scrape to finish before refreshing
// the campaigns table.

import { get } from "../api.js";
import { pool } from "../db.js";
import { listCompanies } from "../scrapers/companies.js";
import {
  scrapePromotions,
  recordPromosFromConstants,
} from "../scrapers/promotions.js";
import type { City, ConstantResponse } from "../types.js";

const CITY_NAME = process.env.CITY ?? "Wrocław";

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
    data.cities.find((x) => x.name.toLowerCase() === name.toLowerCase()) ??
    data.cities[0];
  if (c === undefined) {
    throw new Error(`No city matched "${name}"`);
  }
  return c;
};

const run = async (): Promise<void> => {
  console.log(`[promos-now] resolving city ${CITY_NAME}…`);
  const city = await resolveCity(CITY_NAME);
  console.log(`[promos-now] cityId=${city.cityId}`);

  console.log(`[promos-now] listing companies via awarded-and-top…`);
  const companies = await listCompanies(city);

  // Pull /constant for each company in parallel (under the api.ts limiter).
  // We need companyHeader.activePromotionInfo, which has the `separate` flag
  // and is more reliable than awarded-and-top (verified: DOBRYSTART shows
  // here even when the API serves an old awarded-and-top snapshot).
  console.log(
    `[promos-now] fetching /constant for ${companies.length} companies…`
  );
  const constants: { companyId: string; constant: ConstantResponse }[] = [];
  let done = 0;
  await Promise.all(
    companies.map(async (c) => {
      const companyId = c.companyId ?? c.name;
      try {
        const constant = await get<ConstantResponse>(
          `/api/mobile/open/company-card/${companyId}/constant?cityId=${city.cityId}`,
          { companyId }
        );
        constants.push({ companyId, constant });
      } catch (error) {
        console.warn(
          `[promos-now] /constant ${companyId}: ${errMessage(error)}`
        );
      } finally {
        done += 1;
        if (done % 10 === 0 || done === companies.length) {
          console.log(
            `[promos-now]   ${done}/${companies.length} constants fetched`
          );
        }
      }
    })
  );

  await scrapePromotions(city.cityId, companies);
  await recordPromosFromConstants(city.cityId, constants);

  console.log(`[promos-now] ✓ done`);
  await pool.end();
};

// oxlint-disable-next-line promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- top-level entry point
run().catch((error: unknown) => {
  console.error("[promos-now] fatal:", error);
  process.exit(1);
});
