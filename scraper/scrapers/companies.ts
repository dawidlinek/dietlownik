import { get } from "../api";
import type { AwardedAndTopResponse, City, CompanySearchItem } from "../types";

// One page covers every city seen so far (152–153 caterings at most); the
// loop below still follows totalPages if a city ever lists more. ~0.7 MB per
// city at this size, against four round-trips at 50.
const PAGE_SIZE = 200;

export interface CityListing {
  /** dietly's own city record (SIMC id, county, municipality, …). */
  readonly city: City | null;
  readonly items: CompanySearchItem[];
  /** totalElements as reported; items.length should match it. */
  readonly total: number;
}

/**
 * Every catering that delivers to a city, via the JSON `awarded-and-top`
 * endpoint (`rV=V2023_1` carries `activePromotionInfo` and `params`, so
 * promotions and delivery flags need no per-company fetch).
 */
export const fetchCityListing = async (
  cityId: number
): Promise<CityListing> => {
  const items: CompanySearchItem[] = [];
  let city: City | null = null;
  let page = 0;
  let totalPages = 1;
  let total = 0;

  while (page < totalPages) {
    const data = await get<AwardedAndTopResponse>(
      `/api/open/search/full/awarded-and-top?cId=${cityId}&rV=V2023_1&pageSize=${PAGE_SIZE}&page=${page}&active=`
    );
    city ??= data.city ?? null;
    totalPages = data.totalPages ?? 1;
    total = data.totalElements ?? 0;
    for (const c of data.searchData ?? []) {
      items.push({ ...c, companyId: c.name });
    }
    page += 1;
  }
  return { city, items, total };
};

export const listCompanies = async (
  city: Readonly<City>
): Promise<CompanySearchItem[]> => {
  console.log(
    `[companies] listing ${city.name} (cityId=${city.cityId}) via awarded-and-top...`
  );
  const { items, total } = await fetchCityListing(city.cityId);
  console.log(`[companies] ✓ ${items.length}/${total} companies collected`);
  return items;
};
