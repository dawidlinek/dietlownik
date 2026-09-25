import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { q as dbQuery } from "@/scraper/db";

const DB_SKIP =
  process.env.DATABASE_URL === undefined || process.env.DATABASE_URL === "";

// Quote value columns in PRICE_SPAN order; delivery 5 is inside total.
const quote = (total: number): unknown[] => [
  total - 5,
  total,
  total - 5,
  null,
  5,
  null,
  0,
  null,
  0,
  0,
  0,
  0,
  0,
  null,
  null,
];

/**
 * The national scrape scrapes each catering once, from a home city, and
 * serves every other city from it: a city advertising the same diet prices
 * borrows the home quotes (with its own delivery fee), a city advertising
 * different prices gets its own quoted group. These tests drive the real
 * SQL — assignHomeCities, assignPriceCities, priceGroupTargets and
 * city_quotes() — with a throwaway catering delivering to four test cities:
 *
 *   HOME  advertises 60 zł, fee 5 — the anchor, quoted
 *   SAME  advertises 60 zł, fee 8 — borrows HOME, +3 zł delivery
 *   DIFF  advertises 66 zł, fee 5 — its own price group, quoted
 *   NONE  advertises nothing      — borrows HOME (some caterings never
 *                                   publish advertised prices at all)
 */
describe.skipIf(DB_SKIP)(
  "national scrape: home cities and price groups",
  () => {
    const COMPANY = "__national_test__";
    const HOME = 999_999_911;
    const SAME = 999_999_912;
    const DIFF = 999_999_913;
    const NONE = 999_999_914;
    const NOT_A_MEMBER = 999_999_919;
    const CITIES = [HOME, SAME, DIFF, NONE, NOT_A_MEMBER];
    const DC = 1;

    let q: typeof dbQuery;

    const cleanup = async (): Promise<void> => {
      await q("DELETE FROM companies WHERE company_id = $1", [COMPANY]);
      await q("DELETE FROM cities WHERE city_id = ANY ($1::bigint[])", [
        CITIES,
      ]);
    };

    beforeAll(async () => {
      ({ q } = await import("@/scraper/db"));
      await cleanup();
      for (const id of CITIES) {
        await q(
          "INSERT INTO cities (city_id, name, tracked) VALUES ($1, $2, TRUE)",
          [id, `Test ${id}`]
        );
      }
      await q("INSERT INTO companies (company_id, name) VALUES ($1, 'Test')", [
        COMPANY,
      ]);
      await q(
        "INSERT INTO diets (company_id, diet_id, name) VALUES ($1, 1, 'Dieta')",
        [COMPANY]
      );
      await q(
        "INSERT INTO tiers (company_id, diet_id, tier_id, name) VALUES ($1, 1, 0, 'T')",
        [COMPANY]
      );
      await q(
        `INSERT INTO diet_options (company_id, diet_id, tier_id, diet_option_id, name)
       VALUES ($1, 1, 0, 0, 'O')`,
        [COMPANY]
      );
      await q(
        `INSERT INTO diet_calories
         (diet_calories_id, company_id, diet_id, tier_id, diet_option_id, calories)
       VALUES ($1, $2, 1, 0, 0, 1500)`,
        [DC, COMPANY]
      );
      for (const [city, fee] of [
        [HOME, 5],
        [SAME, 8],
        [DIFF, 5],
        [NONE, null],
      ] as const) {
        await q(
          `INSERT INTO company_cities (company_id, city_id, delivery_fee)
         VALUES ($1, $2, $3)`,
          [COMPANY, city, fee]
        );
      }

      const { recordAdvertisedPrices } =
        await import("@/scraper/scrapers/catalog-extras");
      const advertised = (price: string) => [
        {
          defaultPrice: price,
          dietCaloriesIds: [DC],
          dietId: 1,
          dietPriceInCompanyPromotion: false,
          discountPrice: price,
        },
      ];
      await recordAdvertisedPrices(COMPANY, HOME, advertised("60.00 zł"));
      await recordAdvertisedPrices(COMPANY, SAME, advertised("60.00 zł"));
      await recordAdvertisedPrices(COMPANY, DIFF, advertised("66.00 zł"));

      const { recordQuote } = await import("@/scraper/scrapers/prices");
      const key = {
        companyId: COMPANY,
        dietCaloriesId: DC,
        orderDays: 1,
        promoCodes: [] as string[],
        tierId: 0,
      };
      await recordQuote({ ...key, cityId: HOME }, quote(65));
      await recordQuote({ ...key, cityId: DIFF }, quote(71));
    });

    afterAll(async () => {
      await cleanup();
    });

    const home = async (): Promise<number | null> => {
      const { rows } = await q<{ home_city_id: string | null }>(
        "SELECT home_city_id FROM companies WHERE company_id = $1",
        [COMPANY]
      );
      const id = rows[0]?.home_city_id ?? null;
      return id === null ? null : Number(id);
    };

    it("homes a catering at the anchor, keeps it, and moves it when it stops delivering", async () => {
      const { assignHomeCities } =
        await import("@/scraper/scrapers/price-groups");
      await assignHomeCities(HOME, [COMPANY]);
      expect(await home()).toBe(HOME);

      // Anchor elsewhere: an existing valid home is sticky.
      await assignHomeCities(NOT_A_MEMBER, [COMPANY]);
      expect(await home()).toBe(HOME);

      // Home membership ends: the lowest remaining tracked city takes over.
      await q(
        "UPDATE company_cities SET is_active = FALSE WHERE company_id = $1 AND city_id = $2",
        [COMPANY, HOME]
      );
      await assignHomeCities(NOT_A_MEMBER, [COMPANY]);
      expect(await home()).toBe(SAME);

      await q(
        "UPDATE company_cities SET is_active = TRUE WHERE company_id = $1 AND city_id = $2",
        [COMPANY, HOME]
      );
      await assignHomeCities(HOME, [COMPANY]);
      expect(await home()).toBe(HOME);
    });

    it("groups cities by advertised prices", async () => {
      const { assignPriceCities, priceGroupTargets } =
        await import("@/scraper/scrapers/price-groups");
      await assignPriceCities([COMPANY]);
      const { rows } = await q<{
        city_id: string;
        price_city_id: string | null;
      }>(
        `SELECT city_id, price_city_id FROM company_cities
        WHERE company_id = $1 ORDER BY city_id`,
        [COMPANY]
      );
      expect(
        rows.map(
          (r: Readonly<{ city_id: string; price_city_id: string | null }>) => [
            Number(r.city_id),
            r.price_city_id === null ? null : Number(r.price_city_id),
          ]
        )
      ).toEqual([
        [HOME, HOME],
        [SAME, HOME],
        [DIFF, DIFF],
        [NONE, HOME],
      ]);
      expect(await priceGroupTargets([COMPANY])).toEqual([
        { cityId: DIFF, companyId: COMPANY },
      ]);
    });

    interface CityQuote {
      total_cost: string;
      total_delivery_cost: string;
      quoted_city_id: string;
    }

    const cityQuote = async (city: number): Promise<CityQuote[]> => {
      const { rows } = await q<CityQuote>(
        `SELECT total_cost::text, total_delivery_cost::text, quoted_city_id::text
         FROM city_quotes($1)
        WHERE company_id = $2 AND closed_at IS NULL`,
        [city, COMPANY]
      );
      return rows;
    };

    it("serves each city its price city's quote with its own delivery fee", async () => {
      // Exactly as quoted.
      expect(await cityQuote(HOME)).toEqual([
        {
          quoted_city_id: String(HOME),
          total_cost: "65.00",
          total_delivery_cost: "5.00",
        },
      ]);
      // Borrowed from HOME, delivery 5 → 8.
      expect(await cityQuote(SAME)).toEqual([
        {
          quoted_city_id: String(HOME),
          total_cost: "68.00",
          total_delivery_cost: "8.00",
        },
      ]);
      // Its own group's quote.
      expect(await cityQuote(DIFF)).toEqual([
        {
          quoted_city_id: String(DIFF),
          total_cost: "71.00",
          total_delivery_cost: "5.00",
        },
      ]);
      // Advertises nothing: borrows HOME. No advertised fee reads as 0
      // (83 of 85 such caterings quote 0 delivery), so HOME's 5 comes off.
      expect(await cityQuote(NONE)).toEqual([
        {
          quoted_city_id: String(HOME),
          total_cost: "60.00",
          total_delivery_cost: "0.00",
        },
      ]);
    });

    it("stops serving a city once the catering leaves it", async () => {
      await q(
        "UPDATE company_cities SET is_active = FALSE WHERE company_id = $1 AND city_id = $2",
        [COMPANY, SAME]
      );
      expect(await cityQuote(SAME)).toEqual([]);
      await q(
        "UPDATE company_cities SET is_active = TRUE WHERE company_id = $1 AND city_id = $2",
        [COMPANY, SAME]
      );
    });

    it("includes the catering in the national universe at its home city", async () => {
      const { nationalTargets } =
        await import("@/scraper/scrapers/price-groups");
      const targets = await nationalTargets();
      expect(
        targets.filter(
          (t: Readonly<{ companyId: string }>) => t.companyId === COMPANY
        )
      ).toEqual([{ cityId: HOME, companyId: COMPANY }]);
    });

    const priceCityOf = async (city: number): Promise<number | null> => {
      const { rows } = await q<{ price_city_id: string | null }>(
        `SELECT price_city_id FROM company_cities
          WHERE company_id = $1 AND city_id = $2`,
        [COMPANY, city]
      );
      const id = rows[0]?.price_city_id ?? null;
      return id === null ? null : Number(id);
    };

    it("splits off a city whose 'from' price differs even when diet prices match", async () => {
      const { assignPriceCities } =
        await import("@/scraper/scrapers/price-groups");
      // Same per-diet prices as HOME, but a different menu-configuration
      // "from" price: a package priced per city hides exactly like this.
      await q(
        `UPDATE company_cities SET lowest_price_menu_config = 55
          WHERE company_id = $1 AND city_id = $2`,
        [COMPANY, SAME]
      );
      await assignPriceCities([COMPANY]);
      expect(await priceCityOf(SAME)).toBe(SAME);

      await q(
        `UPDATE company_cities SET lowest_price_menu_config = NULL
          WHERE company_id = $1 AND city_id = $2`,
        [COMPANY, SAME]
      );
      await assignPriceCities([COMPANY]);
      expect(await priceCityOf(SAME)).toBe(HOME);
    });

    it("closes quotes left in a city that is no longer quoted", async () => {
      const { closeUnquotedPrices } =
        await import("@/scraper/scrapers/price-groups");
      const { recordQuote } = await import("@/scraper/scrapers/prices");
      // SAME was its own price group once; now it borrows HOME.
      await recordQuote(
        {
          cityId: SAME,
          companyId: COMPANY,
          dietCaloriesId: DC,
          orderDays: 1,
          promoCodes: [],
          tierId: 0,
        },
        quote(69)
      );
      expect(await closeUnquotedPrices([COMPANY])).toBe(1);
      const { rows } = await q<{ city_id: string; open: boolean }>(
        `SELECT city_id, closed_at IS NULL AS open FROM price_history
          WHERE company_id = $1 ORDER BY city_id`,
        [COMPANY]
      );
      expect(
        rows.map((r: Readonly<{ city_id: string; open: boolean }>) => [
          Number(r.city_id),
          r.open,
        ])
      ).toEqual([
        [HOME, true],
        [SAME, false],
        [DIFF, true],
      ]);
    });
  }
);
