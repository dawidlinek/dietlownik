// Home cities and price groups — how the national scrape covers every
// tracked city with one scrape per catering.
//
// Measured (CLAUDE.md "City scope"): catalogs and menus are identical in
// every city; ~5% of caterings price by city, and when they do, a city's
// quoted price follows its advertised per-diet prices (/city dietPriceInfo)
// — 7 of 7 quote differences showed up there too. So:
//
//   home city     each catering is scraped (catalog, menus, quotes) from one
//                 tracked city it delivers to: the anchor when possible,
//                 else it stays where it was, else the lowest city id.
//   price city    per (catering, city): whose quotes apply. The home city if
//                 this city advertises the same diet prices; otherwise one
//                 representative per distinct advertised price list (lowest
//                 city id). Cities sharing a list share one set of quotes.
//   group quotes  the national pass quotes every catering at its home city;
//                 each representative that isn't a home city is quoted too.
//
// city_quotes(city) (db/schema.sql) reads the price city's quotes and swaps
// in the city's own delivery fee.

import { q } from "../db";

/**
 * Pick each catering's home among its active memberships in tracked cities.
 * `companyIds` limits the pass; null = every catering. Returns how many
 * caterings moved.
 */
export const assignHomeCities = async (
  anchorCityId: number,
  companyIds: readonly string[] | null = null
): Promise<number> => {
  const { rowCount } = await q(
    `WITH m AS (
       SELECT cc.company_id, cc.city_id
         FROM company_cities cc JOIN cities c USING (city_id)
        WHERE cc.is_active AND c.tracked
     ),
     choice AS (
       SELECT co.company_id,
              CASE
                WHEN EXISTS (SELECT 1 FROM m WHERE m.company_id = co.company_id
                                               AND m.city_id = $1) THEN $1
                WHEN EXISTS (SELECT 1 FROM m WHERE m.company_id = co.company_id
                                               AND m.city_id = co.home_city_id)
                  THEN co.home_city_id
                ELSE (SELECT min(m.city_id) FROM m WHERE m.company_id = co.company_id)
              END AS home
         FROM companies co
        WHERE $2::text[] IS NULL OR co.company_id = ANY ($2::text[])
     )
     UPDATE companies co SET home_city_id = choice.home
       FROM choice
      WHERE choice.company_id = co.company_id
        AND choice.home IS NOT NULL
        AND co.home_city_id IS DISTINCT FROM choice.home`,
    [anchorCityId, companyIds]
  );
  return rowCount ?? 0;
};

/**
 * Set company_cities.price_city_id from what each city advertises: the open
 * per-diet prices (/city dietPriceInfo) plus the city's "from" prices
 * (lowestPrice.standard / .menuConfiguration). The "from" prices are there
 * for tier-level pricing: dietPriceInfo is per diet, so a catering pricing
 * one meal-count package differently per city could keep every diet price
 * the same, but not the menu-configuration "from" price. `companyIds`
 * limits the pass (single-catering runs); null = every catering. Returns how
 * many memberships changed price city.
 *
 * A city that advertises nothing borrows the home city's quotes: some
 * caterings never publish dietPriceInfo at all (maczfit, diet4u, … — 0
 * advertised rows ever, hundreds of real quotes), so an empty list says
 * nothing about whether prices differ.
 */
export const assignPriceCities = async (
  companyIds: readonly string[] | null = null
): Promise<number> => {
  const { rowCount } = await q(
    `WITH diets AS (
       SELECT cc.company_id, cc.city_id,
              -- FILTER: a city advertising nothing LEFT JOINs one all-NULL
              -- row, which format() would turn into ':::' — a fake list.
              COALESCE(string_agg(
                format('%s:%s:%s:%s', a.diet_id, a.default_price,
                       a.discount_price, a.in_promotion),
                '|' ORDER BY a.diet_id) FILTER (WHERE a.id IS NOT NULL), '') AS d,
              format('%s/%s', cc.lowest_price_standard,
                     cc.lowest_price_menu_config) AS lowest,
              cc.lowest_price_standard IS NULL
                AND cc.lowest_price_menu_config IS NULL AS no_lowest
         FROM company_cities cc
         LEFT JOIN diet_advertised_prices a
           ON a.company_id = cc.company_id AND a.city_id = cc.city_id
          AND a.closed_at IS NULL
        WHERE cc.is_active
          AND ($1::text[] IS NULL OR cc.company_id = ANY ($1::text[]))
        GROUP BY cc.company_id, cc.city_id
     ),
     sig AS (
       SELECT company_id, city_id,
              CASE WHEN d = '' AND no_lowest THEN '' ELSE d || '#' || lowest END AS s
         FROM diets
     ),
     rep AS (
       -- The home city represents its own price list; any other list is
       -- represented by its lowest city id.
       SELECT s.company_id, s.s,
              (array_agg(s.city_id ORDER BY (s.city_id = co.home_city_id) DESC,
                                            s.city_id))[1] AS city_id
         FROM sig s JOIN companies co USING (company_id)
        GROUP BY s.company_id, s.s
     ),
     target AS (
       SELECT s.company_id, s.city_id,
              CASE WHEN s.s = '' THEN co.home_city_id ELSE r.city_id END
                AS price_city_id
         FROM sig s
         JOIN rep r USING (company_id, s)
         JOIN companies co USING (company_id)
     )
     UPDATE company_cities cc SET price_city_id = t.price_city_id
       FROM target t
      WHERE cc.company_id = t.company_id AND cc.city_id = t.city_id
        AND cc.price_city_id IS DISTINCT FROM t.price_city_id`,
    [companyIds]
  );
  return rowCount ?? 0;
};

/**
 * Close open quotes in cities no longer quoted for their catering — neither
 * its home city nor any membership's price city (a group that dissolved, a
 * home that moved). They would otherwise stay "current" forever with no
 * scrape to refresh or close them; city_quotes() already ignores them.
 * Never touches a home city or a current price city, so it is safe to run
 * whenever homes and price cities are up to date. Returns spans closed.
 */
export const closeUnquotedPrices = async (
  companyIds: readonly string[] | null = null
): Promise<number> => {
  const { rowCount } = await q(
    `UPDATE price_history h SET closed_at = NOW()
      WHERE h.closed_at IS NULL
        AND ($1::text[] IS NULL OR h.company_id = ANY ($1::text[]))
        AND NOT EXISTS (SELECT 1 FROM companies co
                         WHERE co.company_id = h.company_id
                           AND co.home_city_id = h.city_id)
        AND NOT EXISTS (SELECT 1 FROM company_cities cc
                         WHERE cc.company_id = h.company_id AND cc.is_active
                           AND cc.price_city_id = h.city_id)`,
    [companyIds]
  );
  return rowCount ?? 0;
};

export interface Target {
  readonly companyId: string;
  readonly cityId: number;
}

/**
 * The national universe: every catering with an active membership in a
 * tracked city, with its home city.
 */
export const nationalTargets = async (): Promise<Target[]> => {
  const { rows } = await q<{ company_id: string; home_city_id: string }>(
    `SELECT co.company_id, co.home_city_id
       FROM companies co
      WHERE co.home_city_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM company_cities cc JOIN cities c USING (city_id)
                     WHERE cc.company_id = co.company_id AND cc.is_active
                       AND c.tracked)
      ORDER BY co.company_id`
  );
  return rows.map(
    (r: Readonly<{ company_id: string; home_city_id: string }>) => ({
      cityId: Number(r.home_city_id),
      companyId: r.company_id,
    })
  );
};

/** Price-group representatives that the home-city pass doesn't quote. */
export const priceGroupTargets = async (
  companyIds: readonly string[] | null = null
): Promise<Target[]> => {
  const { rows } = await q<{ company_id: string; price_city_id: string }>(
    `SELECT DISTINCT cc.company_id, cc.price_city_id
       FROM company_cities cc JOIN companies co USING (company_id)
      WHERE cc.is_active
        AND cc.price_city_id IS NOT NULL
        AND cc.price_city_id IS DISTINCT FROM co.home_city_id
        AND ($1::text[] IS NULL OR cc.company_id = ANY ($1::text[]))
      ORDER BY cc.company_id, cc.price_city_id`,
    [companyIds]
  );
  return rows.map(
    (r: Readonly<{ company_id: string; price_city_id: string }>) => ({
      cityId: Number(r.price_city_id),
      companyId: r.company_id,
    })
  );
};
