// City name → city_id resolution.
//
// Strategy: prefer Postgres (the scraper has already resolved every city the
// user has cared about). Fall back to dietly's live `top-search` endpoint
// when the city isn't in our DB yet. Per-MCP-session memo so repeated
// resolutions in the same conversation are O(1).

import { q } from "@/scraper/db";

import { fetchWithRetry, parseResponse } from "./http";

interface CityRow {
  readonly city_id: number;
  readonly name: string;
}

interface TopSearchCity {
  readonly cityId: number;
  readonly name: string;
  readonly cityStatus?: boolean;
}

interface TopSearchResponse {
  readonly cities?: readonly TopSearchCity[];
}

const norm = (s: string): string => s.trim().toLowerCase();

export interface ResolvedCity {
  readonly id: number;
  readonly name: string;
}

export class CityResolveError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CityResolveError";
  }
}

const fromDb = async (input: string): Promise<ResolvedCity | undefined> => {
  const res = await q<CityRow>(
    `SELECT city_id, name FROM cities
      WHERE LOWER(name) = LOWER($1) OR LOWER(sanitized_name) = LOWER($1)
      ORDER BY largest_city_for_name DESC NULLS LAST,
               number_of_companies   DESC NULLS LAST
      LIMIT 1`,
    [input]
  );
  const [row] = res.rows;
  return row === undefined ? undefined : { id: row.city_id, name: row.name };
};

const fromApi = async (input: string): Promise<ResolvedCity | undefined> => {
  const url = `https://aplikacja.dietly.pl/api/open/search/top-search?query=${encodeURIComponent(input)}&citiesSize=10&companiesSize=0`;
  const res = await fetchWithRetry(url, {
    cache: "no-store",
    headers: {
      accept: "application/json",
      "accept-language": "pl-PL",
      "x-launcher-type": "ANDROID_APP",
      "x-mobile-version": "4.0.0",
    },
    method: "GET",
  });
  const data = await parseResponse<TopSearchResponse>(
    res,
    "GET",
    "/api/open/search/top-search"
  );
  const wanted = norm(input);
  const cities = data.cities ?? [];
  const exact = cities.find(
    (c: Readonly<TopSearchCity>) =>
      c.cityStatus !== false && norm(c.name) === wanted
  );
  const any = cities.find(
    (c: Readonly<TopSearchCity>) => c.cityStatus !== false
  );
  const pick = exact ?? any;
  return pick === undefined ? undefined : { id: pick.cityId, name: pick.name };
};

// oxlint-disable-next-line max-classes-per-file -- CityResolveError is the resolver's domain error; co-locating keeps the surface single-import
export class CityResolver {
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- per-instance memo cache
  private readonly memo = new Map<string, ResolvedCity>();

  public readonly resolve = async (input: string): Promise<ResolvedCity> => {
    const key = norm(input);
    const cached = this.memo.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const dbHit = await fromDb(input);
    if (dbHit !== undefined) {
      this.memo.set(key, dbHit);
      return dbHit;
    }
    const apiHit = await fromApi(input);
    if (apiHit !== undefined) {
      this.memo.set(key, apiHit);
      return apiHit;
    }
    throw new CityResolveError(
      `City "${input}" not found. Try the Polish name (e.g. "Warszawa", "Kraków", "Wrocław").`
    );
  };
}
