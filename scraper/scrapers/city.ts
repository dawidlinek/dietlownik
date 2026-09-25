// Cities: resolution by name, the stored city record, and the tracked set.
//
// dietly's cityId is the GUS TERYT SIMC code, so any of Poland's ~100k
// localities is addressable, and names repeat (seven Józefów in Mazowieckie
// alone). The scraper cannot refresh every locality; it keeps a TRACKED set
// fresh (scraper/scrapers/city-refresh.ts) and scrapes each catering once,
// from a home city (see CLAUDE.md "City scope").

import { get } from "../api";
import { q } from "../db";
import type { City, DeepReadonly, TopSearchResponse } from "../types";

/**
 * The default tracked set: Poland's 66 cities with powiat rights — every
 * voivodeship capital plus the other large towns. Across them 177 distinct
 * caterings appeared (2026-09-23), 25 of which never deliver to Wrocław.
 */
export const COUNTY_CITIES: readonly string[] = [
  "Jelenia Góra",
  "Legnica",
  "Wałbrzych",
  "Wrocław",
  "Bydgoszcz",
  "Grudziądz",
  "Toruń",
  "Włocławek",
  "Biała Podlaska",
  "Chełm",
  "Lublin",
  "Zamość",
  "Gorzów Wielkopolski",
  "Zielona Góra",
  "Łódź",
  "Piotrków Trybunalski",
  "Skierniewice",
  "Kraków",
  "Nowy Sącz",
  "Tarnów",
  "Ostrołęka",
  "Płock",
  "Radom",
  "Siedlce",
  "Warszawa",
  "Opole",
  "Krosno",
  "Przemyśl",
  "Rzeszów",
  "Tarnobrzeg",
  "Białystok",
  "Łomża",
  "Suwałki",
  "Gdańsk",
  "Gdynia",
  "Słupsk",
  "Sopot",
  "Bielsko-Biała",
  "Bytom",
  "Chorzów",
  "Częstochowa",
  "Dąbrowa Górnicza",
  "Gliwice",
  "Jastrzębie-Zdrój",
  "Jaworzno",
  "Katowice",
  "Mysłowice",
  "Piekary Śląskie",
  "Ruda Śląska",
  "Rybnik",
  "Siemianowice Śląskie",
  "Sosnowiec",
  "Świętochłowice",
  "Tychy",
  "Zabrze",
  "Żory",
  "Kielce",
  "Elbląg",
  "Olsztyn",
  "Kalisz",
  "Konin",
  "Leszno",
  "Poznań",
  "Koszalin",
  "Szczecin",
  "Świnoujście",
];

// dietly's search misses some exact names that a prefix finds: nothing for
// "Świnoujście", a hit for "Świnouj". Retry with up to this many characters
// dropped before giving up on an exact match.
const PREFIX_RETRIES = 5;

const topSearch = async (query: string): Promise<City[]> => {
  const data = await get<TopSearchResponse>(
    `/api/open/search/top-search?query=${encodeURIComponent(query)}&citiesSize=10&companiesSize=0`
  );
  return data.cities ?? [];
};

/**
 * Resolve a Polish locality name to dietly's city record. Prefers an exact
 * name match flagged `largestCityForName` (so "Józefów" means the town, not
 * one of the villages), then any exact match; a query with no exact match is
 * retried with shorter prefixes. Falls back to dietly's first active hit.
 */
export const resolveCityByName = async (name: string): Promise<City | null> => {
  const wanted = name.trim().toLowerCase();
  let firstActive: City | null = null;
  for (let cut = 0; cut <= PREFIX_RETRIES; cut += 1) {
    const query = name.trim().slice(0, Math.max(4, wanted.length - cut));
    const cities = await topSearch(query);
    firstActive ??=
      cities.find((c: DeepReadonly<City>) => c.cityStatus) ?? null;
    const exact = cities.filter(
      (c: DeepReadonly<City>) => c.name.toLowerCase() === wanted
    );
    const hit =
      exact.find((c: DeepReadonly<City>) => c.largestCityForName) ??
      exact.find((c: DeepReadonly<City>) => c.cityStatus) ??
      exact[0];
    if (hit !== undefined) {
      return hit;
    }
    if (query.length <= 4) {
      break;
    }
  }
  return firstActive;
};

/** Store dietly's city record. Never touches `tracked`. */
export const upsertCity = async (city: DeepReadonly<City>): Promise<void> => {
  await q(
    `INSERT INTO cities
       (city_id, name, sanitized_name, province_name, county_name,
        municipality_name, largest_city_for_name, number_of_companies)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (city_id) DO UPDATE SET
       name                  = EXCLUDED.name,
       sanitized_name        = EXCLUDED.sanitized_name,
       province_name         = EXCLUDED.province_name,
       county_name           = COALESCE(EXCLUDED.county_name, cities.county_name),
       municipality_name     = COALESCE(EXCLUDED.municipality_name, cities.municipality_name),
       largest_city_for_name = COALESCE(EXCLUDED.largest_city_for_name, cities.largest_city_for_name),
       number_of_companies   = COALESCE(EXCLUDED.number_of_companies, cities.number_of_companies),
       updated_at            = NOW()`,
    [
      city.cityId,
      city.name,
      city.sanitizedName ?? null,
      city.provinceName ?? null,
      city.countyName ?? null,
      city.municipalityName ?? null,
      city.largestCityForName ?? null,
      city.numberOfCompanies ?? null,
    ]
  );
};

/** Resolve, store and return the anchor city (the preferred home city). */
export const scrapeCity = async (cityName = "Wrocław"): Promise<City> => {
  console.log(`[city] resolving "${cityName}"...`);
  const city = await resolveCityByName(cityName);
  if (city === null) {
    throw new Error(`City not found: ${cityName}`);
  }
  await upsertCity(city);
  console.log(
    `[city] ✓ ${city.name} id=${city.cityId} (${city.numberOfCompanies} caterings)`
  );
  return city;
};

export interface TrackedCity {
  readonly city_id: number;
  readonly name: string;
  /** Epoch ms of the last complete refresh, or null if never refreshed. */
  readonly last_refreshed_ms: number | null;
}

export const getTrackedCities = async (): Promise<TrackedCity[]> => {
  const { rows } = await q<{
    city_id: string;
    name: string;
    last_refreshed_ms: number | null;
  }>(
    `SELECT city_id, name,
            (extract(epoch FROM last_refreshed_at) * 1000)::float8 AS last_refreshed_ms
       FROM cities
      WHERE tracked ORDER BY last_refreshed_at ASC NULLS FIRST, city_id`
  );
  return rows.map(
    (
      r: Readonly<{
        city_id: string;
        name: string;
        last_refreshed_ms: number | null;
      }>
    ) => ({
      city_id: Number(r.city_id),
      last_refreshed_ms: r.last_refreshed_ms,
      name: r.name,
    })
  );
};

/**
 * Resolve names and mark them tracked. Returns the names that did not
 * resolve (dietly's search didn't know them) so callers can report them.
 */
export const trackCities = async (
  names: readonly string[]
): Promise<{ tracked: City[]; unresolved: string[] }> => {
  const tracked: City[] = [];
  const unresolved: string[] = [];
  for (const name of names) {
    const city = await resolveCityByName(name);
    if (city === null) {
      unresolved.push(name);
      continue;
    }
    await upsertCity(city);
    await q(`UPDATE cities SET tracked = TRUE WHERE city_id = $1`, [
      city.cityId,
    ]);
    tracked.push(city);
  }
  return { tracked, unresolved };
};
