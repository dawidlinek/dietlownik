import { get } from "../api";
import { q } from "../db";
import type { City, TopSearchResponse } from "../types";

export const scrapeCity = async (cityName = "Wrocław"): Promise<City> => {
  console.log(`[city] resolving "${cityName}"...`);
  const data = await get<TopSearchResponse>(
    `/api/open/search/top-search?query=${encodeURIComponent(cityName)}&citiesSize=10&companiesSize=0`
  );

  const city =
    data.cities.find(
      (c: Readonly<City>) =>
        c.cityStatus && c.name.toLowerCase() === cityName.toLowerCase()
    ) ?? data.cities.find((c: Readonly<City>) => c.cityStatus);

  if (!city) {
    throw new Error(`City not found: ${cityName}`);
  }

  await q(
    `INSERT INTO cities
       (city_id, name, sanitized_name, province_name, number_of_companies)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (city_id) DO UPDATE SET
       name                = EXCLUDED.name,
       sanitized_name      = EXCLUDED.sanitized_name,
       province_name       = EXCLUDED.province_name,
       number_of_companies = EXCLUDED.number_of_companies,
       updated_at          = NOW()`,
    [
      city.cityId,
      city.name,
      city.sanitizedName,
      city.provinceName,
      city.numberOfCompanies,
    ]
  );

  console.log(
    `[city] ✓ ${city.name} id=${city.cityId} (${city.numberOfCompanies} caterings)`
  );
  return city;
};
