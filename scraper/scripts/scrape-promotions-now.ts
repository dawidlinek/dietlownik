// One-off: walk awarded-and-top + per-company /constant headers right now,
// persist whatever promo info is currently exposed by the API. Useful when
// you don't want to wait for the full scrape to finish before refreshing
// the campaigns table.

import { listCompanies } from '../scrapers/companies.js';
import { scrapePromotions, recordPromosFromConstants } from '../scrapers/promotions.js';
import { get } from '../api.js';
import { pool } from '../db.js';
import type { City, ConstantResponse } from '../types.js';

const CITY_NAME = process.env.CITY ?? 'Wrocław';

interface TopSearchResponse {
  cities: City[];
}

async function resolveCity(name: string): Promise<City> {
  const data = await get<TopSearchResponse>(
    `/api/open/search/top-search?query=${encodeURIComponent(name)}&citiesSize=10&companiesSize=0`,
  );
  const c =
    data.cities.find((x) => x.name.toLowerCase() === name.toLowerCase()) ??
    data.cities[0];
  if (!c) throw new Error(`No city matched "${name}"`);
  return c;
}

async function run(): Promise<void> {
  console.log(`[promos-now] resolving city ${CITY_NAME}…`);
  const city = await resolveCity(CITY_NAME);
  console.log(`[promos-now] cityId=${city.cityId}`);

  console.log(`[promos-now] listing companies via awarded-and-top…`);
  const companies = await listCompanies(city);

  // Pull /constant for each company in parallel (under the api.ts limiter).
  // We need companyHeader.activePromotionInfo, which has the `separate` flag
  // and is more reliable than awarded-and-top (verified: DOBRYSTART shows
  // here even when the API serves an old awarded-and-top snapshot).
  console.log(`[promos-now] fetching /constant for ${companies.length} companies…`);
  const constants: Array<{ companyId: string; constant: ConstantResponse }> = [];
  let done = 0;
  await Promise.all(
    companies.map(async (c) => {
      const companyId = c.companyId ?? c.name;
      try {
        const constant = await get<ConstantResponse>(
          `/api/mobile/open/company-card/${companyId}/constant?cityId=${city.cityId}`,
          { companyId },
        );
        constants.push({ companyId, constant });
      } catch (err) {
        console.warn(`[promos-now] /constant ${companyId}: ${(err as Error).message}`);
      } finally {
        done += 1;
        if (done % 10 === 0 || done === companies.length) {
          console.log(`[promos-now]   ${done}/${companies.length} constants fetched`);
        }
      }
    }),
  );

  await scrapePromotions(city.cityId, companies);
  await recordPromosFromConstants(city.cityId, constants);

  console.log(`[promos-now] ✓ done`);
  await pool.end();
}

run().catch((err) => {
  console.error('[promos-now] fatal:', err);
  process.exit(1);
});
