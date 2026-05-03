// Integration tests against the real mobile API (aplikacja.dietly.pl).
//
// Gated by INTEGRATION=1 so `npm test` stays fast and offline by default.
// Run with:  INTEGRATION=1 npm test
//
// Notes on memory & resource hygiene:
// - Total HTTP calls in this file: ~10. No fan-out, no accumulating arrays
//   between tests, no DB pool (we only test the API surface).
// - We rely on Node's global `fetch` which uses undici's keep-alive pool;
//   when the test process exits at the end of vitest's run, all sockets
//   close. There's no need (and no API) to drain it manually.
// - The api.ts module-level Limiter has bounded state (a small waiters[]
//   array that empties as requests complete). With ~10 sequential requests
//   it never grows.
// - We only assert shape, not field values, since live data drifts.

import { describe, it, expect } from "vitest";

import { get, post, HttpError } from "../api.js";
import type {
  AwardedAndTopResponse,
  Banner,
  CityResponse,
  ConstantResponse,
  MenuResponse,
  PriceResponse,
  TopSearchResponse,
} from "../types.js";

// Stable test target: Wrocław (cityId 986283) + robinfood (one of the most
// active companies, large catalog, supports menu).
const CITY = "Wrocław";
const CITY_ID = 986_283;
const COMPANY_ID = "robinfood";

// vitest's `describe.runIf` (plain JS truthy check) keeps these out of
// default runs; the matching env makes the whole suite live.
const RUN = process.env.INTEGRATION === "1";

describe.runIf(RUN)("integration: aplikacja.dietly.pl mobile API", () => {
  it("GET /api/open/search/top-search returns the city", async () => {
    const data = await get<TopSearchResponse>(
      `/api/open/search/top-search?query=${encodeURIComponent(CITY)}&citiesSize=5&companiesSize=0`
    );
    expect(Array.isArray(data.cities)).toBe(true);
    expect(data.cities.length).toBeGreaterThan(0);
    const city = data.cities.find((c) => c.cityId === CITY_ID);
    expect(city).toBeDefined();
    expect(city?.name).toBe(CITY);
    expect(typeof city?.numberOfCompanies).toBe("number");
  }, 15_000);

  it("GET awarded-and-top returns >=20 companies for Wrocław", async () => {
    const data = await get<AwardedAndTopResponse>(
      `/api/open/search/full/awarded-and-top?cId=${CITY_ID}&rV=V2023_1&pageSize=20&page=0&active=`
    );
    expect(typeof data.totalElements).toBe("number");
    expect(data.totalElements).toBeGreaterThan(20);
    expect(Array.isArray(data.searchData)).toBe(true);
    expect(data.searchData.length).toBeGreaterThan(0);
    // Sanity: each entry has the slug-as-`name` shape we rely on.
    for (const c of data.searchData.slice(0, 3)) {
      expect(typeof c.name).toBe("string");
      expect(c.name.length).toBeGreaterThan(0);
      expect(typeof c.fullName).toBe("string");
    }
  }, 15_000);

  it("GET /constant returns the diet/tier/option tree (companyHeader.rateValue present)", async () => {
    const data = await get<ConstantResponse>(
      `/api/mobile/open/company-card/${COMPANY_ID}/constant?cityId=${CITY_ID}`,
      { companyId: COMPANY_ID }
    );
    expect(Array.isArray(data.companyDiets)).toBe(true);
    expect(data.companyDiets.length).toBeGreaterThan(0);

    // The reason this scraper exists in its current form: rateValue is the
    // real "company score 0..100" field on mobile, not avgScore.
    expect(typeof data.companyHeader.rateValue).toBe("number");
    expect(data.companyHeader.rateValue!).toBeGreaterThan(0);
    expect(data.menuSettings).toBeDefined();
    expect(typeof data.menuSettings.menuDaysAhead).toBe("number");

    // Either menu-config or fixed shape per diet — never both empty for an
    // active diet, never both populated.
    for (const d of data.companyDiets) {
      const hasTiers = (d.dietTiers ?? []).length > 0;
      const hasOpts = (d.dietOptions ?? []).length > 0;
      expect(hasTiers || hasOpts).toBe(true);
      expect(hasTiers && hasOpts).toBe(false);
    }
  }, 15_000);

  it("GET /constant fails with 400 when the company-id header is missing", async () => {
    // This is the entire reason api.ts plumbs companyId through every
    // /company-card/... call. Documenting the requirement with a test.
    await expect(
      get<ConstantResponse>(
        `/api/mobile/open/company-card/${COMPANY_ID}/constant?cityId=${CITY_ID}`
        // No companyId option → no `company-id` header
      )
    ).rejects.toMatchObject({ status: 400 });
  }, 15_000);

  it("GET /city returns dietPriceInfo and lowestPrice", async () => {
    const data = await get<CityResponse>(
      `/api/mobile/open/company-card/${COMPANY_ID}/city/${CITY_ID}`,
      { companyId: COMPANY_ID }
    );
    expect(Array.isArray(data.dietPriceInfo)).toBe(true);
    expect(data.dietPriceInfo.length).toBeGreaterThan(0);
    expect(data.lowestPrice).toBeDefined();
    expect(data.citySearchResult.cityId).toBe(CITY_ID);
  }, 15_000);

  it("POST quick-order/calculate-price returns numeric pricing for a fixed diet", async () => {
    // Fixed-diet quote (no tierDietOptionId). dietCaloriesId 140 = robinfood
    // dieta Standard Food 1200 kcal — verified live; if rebranded the test
    // will need an update.
    const today = new Date();
    today.setDate(today.getDate() + 2);
    const date = today.toISOString().slice(0, 10);

    const res = await post<PriceResponse>(
      `/api/mobile/open/company-card/${COMPANY_ID}/quick-order/calculate-price`,
      {
        cityId: CITY_ID,
        deliveryDates: [date],
        dietCaloriesId: 140,
        promoCodes: [""],
      },
      { companyId: COMPANY_ID }
    );
    expect(res.cart).toBeDefined();
    expect(typeof res.cart.totalCostToPay).toBe("number");
    expect(res.cart.totalCostToPay!).toBeGreaterThan(0);
    expect(Array.isArray(res.items)).toBe(true);
  }, 15_000);

  it("POST calculate-price for a menu-config tier returns a different price than another tier", async () => {
    // dietCaloriesId 77 = Fit Food 1200 kcal — appears under tier 6, 5, 7, 10.
    // tier 7 (Pakiet Basic, 15 meals/day) is cheaper than tier 6 (Comfort, 25
    // meals/day). If those merge or vanish this test needs adjusting.
    const today = new Date();
    today.setDate(today.getDate() + 2);
    const date = today.toISOString().slice(0, 10);

    async function quoteTier(tdoId: string): Promise<number> {
      const r = await post<PriceResponse>(
        `/api/mobile/open/company-card/${COMPANY_ID}/quick-order/calculate-price`,
        {
          cityId: CITY_ID,
          deliveryDates: [date],
          dietCaloriesId: 77,
          promoCodes: [""],
          tierDietOptionId: tdoId,
        },
        { companyId: COMPANY_ID }
      );
      return r.cart.totalCostToPay ?? -1;
    }

    const [comfortPrice, basicPrice] = [
      await quoteTier("6-17"),
      await quoteTier("7-17"),
    ];
    expect(comfortPrice).toBeGreaterThan(0);
    expect(basicPrice).toBeGreaterThan(0);
    // Same kcal id, different tiers, different prices.
    expect(comfortPrice).not.toBe(basicPrice);
  }, 30_000);

  it("GET /menu returns slots with options carrying dish names + nutrition info", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const data = await get<MenuResponse>(
      `/api/mobile/open/company-card/${COMPANY_ID}/menu/65/city/${CITY_ID}/date/${today}?tierId=6`,
      { companyId: COMPANY_ID }
    );
    expect(data.date).toBe(today);
    expect(typeof data.calories).toBe("number");
    expect(Array.isArray(data.meals)).toBe(true);
    expect(data.meals.length).toBeGreaterThan(0);
    const slot = data.meals[0];
    expect(typeof slot.name).toBe("string");
    expect(Array.isArray(slot.options)).toBe(true);
    expect(slot.options.length).toBeGreaterThan(0);
    const opt = slot.options[0];
    expect(typeof opt.name).toBe("string");
    expect(opt.name.length).toBeGreaterThan(0);
    expect(typeof opt.dietCaloriesMealId).toBe("number");
    expect(typeof opt.info).toBe("string");
    // The "info" string is what parseInfoMacros consumes — assert the format
    // we depend on.
    expect(opt.info).toMatch(/\d+\s*kcal/i);
  }, 20_000);

  it("/api/profile/coupons-search → 401 (unauthenticated)", async () => {
    // Not currently used by the scraper, but documenting the auth boundary so
    // anyone tempted to "just hit it" sees the test fail loudly.
    let err: unknown;
    try {
      await get(
        `/api/profile/coupons-search?cityId=${CITY_ID}&companyName=${COMPANY_ID}&deliveriesNumber=10&dietTags=STANDARD&shoppingCartCost=770&page=0&regularShoppingCartCost=770&isAnySeparateCodeInShoppingCart=false`
      );
    } catch (error) {
      err = error;
    }
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(401);
  }, 15_000);

  it("GET /banners returns city-scoped marketing entries", async () => {
    const banners = await get<Banner[]>(
      `/api/open/mobile/banners?cId=${CITY_ID}`
    );
    expect(Array.isArray(banners)).toBe(true);
    // Wrocław has consistently had at least PACZKI + REFERRAL standalone
    // banners over the captures we've inspected; if the API ever returns 0
    // here we want to know.
    expect(banners.length).toBeGreaterThan(0);
    for (const b of banners.slice(0, 3)) {
      expect(typeof b.code).toBe("string");
    }
  }, 15_000);
});
