import { get } from "../api.js";
import type {
  AwardedAndTopResponse,
  City,
  CompanySearchItem,
} from "../types.js";

const PAGE_SIZE = 50;

/**
 * List every company that delivers to a given city, using the JSON
 * `awarded-and-top` endpoint. This replaces the old HTML/__NEXT_DATA__
 * scraper that was capping at ~5 companies per city.
 *
 * `rV=V2023_1` returns the richer per-company shape including
 * `activePromotionInfo` and `params` (so we can populate promotions and
 * delivery flags without a per-company fetch).
 */
export async function listCompanies(city: City): Promise<CompanySearchItem[]> {
  console.log(
    `[companies] listing ${city.name} (cityId=${city.cityId}) via awarded-and-top...`
  );

  const all: CompanySearchItem[] = [];
  let page = 0;
  let totalPages = 1;
  let totalElements = 0;

  while (page < totalPages) {
    const data = await get<AwardedAndTopResponse>(
      `/api/open/search/full/awarded-and-top?cId=${city.cityId}&rV=V2023_1&pageSize=${PAGE_SIZE}&page=${page}&active=`
    );
    totalPages = data.totalPages ?? 1;
    totalElements = data.totalElements ?? 0;
    for (const c of data.searchData ?? []) {
      all.push({ ...c, companyId: c.name });
    }
    console.log(
      `[companies] page ${page + 1}/${totalPages} → +${data.searchData?.length ?? 0} (total ${all.length}/${totalElements})`
    );
    page += 1;
  }

  console.log(`[companies] ✓ ${all.length} companies collected`);
  return all;
}
