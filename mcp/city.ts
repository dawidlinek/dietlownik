// City name → city_id resolution.
//
// Data exists only for TRACKED cities (see CLAUDE.md "City scope"): the
// scraper keeps their catering lists, delivery terms and prices fresh. Any
// other of Poland's ~100k localities resolves fine on dietly's side but has
// no data here, so returning its id would make every tool answer with an
// empty, misleading result. Strategy:
//
//   1. a tracked city by name, from Postgres;
//   2. otherwise dietly's `top-search` (with a prefix retry — dietly finds
//      nothing for the exact "Świnoujście" but does for "Świnouj"): if the
//      locality it finds is tracked, use it;
//   3. otherwise fail with the tracked cities of the same voivodeship, so
//      the agent can pick one (caterings deliver across whole regions).
//
// Per-MCP-session memo so repeated resolutions in the same conversation are
// O(1).

import { q } from "@/scraper/db";

import { fetchWithRetry, parseResponse } from "./http";

interface CityRow {
  // pg returns bigint as string; we coerce with Number() at use site.
  readonly city_id: number | string;
  readonly name: string;
}

interface TopSearchCity {
  readonly cityId: number;
  readonly name: string;
  readonly cityStatus?: boolean;
  readonly provinceName?: string;
  readonly countyName?: string;
  readonly largestCityForName?: boolean;
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

/** A tracked city by name (or URL-safe name); the busiest wins on a clash. */
const fromDb = async (input: string): Promise<ResolvedCity | undefined> => {
  const res = await q<CityRow>(
    `SELECT city_id, name FROM cities
      WHERE tracked
        AND (LOWER(name) = LOWER($1) OR LOWER(sanitized_name) = LOWER($1))
      ORDER BY number_of_companies DESC NULLS LAST,
               city_id ASC
      LIMIT 1`,
    [input]
  );
  const [row] = res.rows;
  return row === undefined
    ? undefined
    : { id: Number(row.city_id), name: row.name };
};

const topSearch = async (query: string): Promise<readonly TopSearchCity[]> => {
  const url = `https://aplikacja.dietly.pl/api/open/search/top-search?query=${encodeURIComponent(query)}&citiesSize=10&companiesSize=0`;
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
  return (data.cities ?? []).filter(
    (c: Readonly<TopSearchCity>) => c.cityStatus !== false
  );
};

// dietly's search misses some exact names that a prefix finds.
const PREFIX_RETRIES = 5;

/**
 * dietly's matches for a name, retrying with shorter prefixes until one
 * matches the name exactly. The exact match (preferring dietly's
 * `largestCityForName`) comes first.
 */
const searchCities = async (
  input: string
): Promise<readonly TopSearchCity[]> => {
  const wanted = norm(input);
  let last: readonly TopSearchCity[] = [];
  for (let cut = 0; cut <= PREFIX_RETRIES; cut += 1) {
    const query = input.trim().slice(0, Math.max(4, wanted.length - cut));
    const cities = await topSearch(query);
    last = cities.length > 0 ? cities : last;
    const exact = cities.filter(
      (c: Readonly<TopSearchCity>) => norm(c.name) === wanted
    );
    if (exact.length > 0) {
      return exact.toSorted(
        (a: Readonly<TopSearchCity>, b: Readonly<TopSearchCity>) =>
          Number(b.largestCityForName === true) -
          Number(a.largestCityForName === true)
      );
    }
    if (query.length <= 4) {
      break;
    }
  }
  return last;
};

const isTracked = async (cityId: number): Promise<ResolvedCity | undefined> => {
  const res = await q<CityRow>(
    `SELECT city_id, name FROM cities WHERE city_id = $1 AND tracked`,
    [cityId]
  );
  const [row] = res.rows;
  return row === undefined
    ? undefined
    : { id: Number(row.city_id), name: row.name };
};

const trackedInProvince = async (province: string): Promise<string[]> => {
  const res = await q<{ name: string }>(
    `SELECT name FROM cities
      WHERE tracked AND province_name = $1
      ORDER BY number_of_companies DESC NULLS LAST, name
      LIMIT 8`,
    [province]
  );
  return res.rows.map((r: Readonly<{ name: string }>) => r.name);
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

    const matches = await searchCities(input);
    const [best] = matches;
    if (best !== undefined && norm(best.name) === key) {
      const tracked = await isTracked(best.cityId);
      if (tracked !== undefined) {
        this.memo.set(key, tracked);
        return tracked;
      }
      const province = best.provinceName ?? "";
      const nearby = province === "" ? [] : await trackedInProvince(province);
      const where = [best.countyName, province.toLowerCase()]
        .filter((s): s is string => s !== undefined && s !== "")
        .join(", ");
      throw new CityResolveError(
        `"${best.name}"${where === "" ? "" : ` (${where})`} is a real locality, but dietlownik has no data for it — only tracked cities are scraped.${
          nearby.length > 0
            ? ` Tracked cities in the same voivodeship: ${nearby.join(", ")}. Most caterings deliver across the whole region, so the nearest of these is a good stand-in.`
            : ""
        }`
      );
    }

    const suggestions = matches.slice(0, 5).map((c) => c.name);
    const suggestionMsg =
      suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "";
    throw new CityResolveError(
      `City "${input}" not found. Try the Polish name (e.g. "Warszawa", "Kraków", "Wrocław").${suggestionMsg}`
    );
  };
}
