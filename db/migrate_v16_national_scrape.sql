-- v16: national scrape — tracked cities, catering home cities, per-city
-- membership lifecycle and price sources, and city_quotes().
--
-- Run through `node db/migrate_v16_national_scrape.js` (one transaction).
--
-- Why (measured 2026-09-22/23, see CLAUDE.md "City scope"): catalogs and
-- menus are the same in every city; ~5% of caterings price by city; the
-- delivery fee is per city; which caterings deliver varies (42–152 per
-- locality). So the scraper fetches each catering once, from a HOME city it
-- delivers to, and keeps only the per-city facts per city:
--
--   cities.tracked                 the cities kept fresh (catering list,
--                                  terms, advertised prices), daily
--   companies.home_city_id         where the national pass scrapes catalog,
--                                  menus and prices from
--   company_cities.is_active/…     membership lifecycle: a catering that
--                                  stops delivering to a city is flipped off,
--                                  not left listed forever
--   company_cities.price_city_id   whose quotes a city uses: the home city
--                                  when this city advertises the same diet
--                                  prices (or none), else one representative
--                                  city per distinct price list (quoted
--                                  separately)
--   city_quotes(city_id)           price_history as seen from a city: the
--                                  price city's quotes, delivery fee swapped
--                                  for this city's
--
-- Backfill: every existing company_cities row is the city it was scraped
-- for, so it is its own price city, and that city is tracked and home.

-- @step preflight
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'menu_items'
                AND column_name = 'city_id') THEN
    RAISE EXCEPTION 'v15 not applied (menu_items.city_id still present)';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'companies'
                AND column_name = 'home_city_id') THEN
    RAISE EXCEPTION 'v16 already applied (companies.home_city_id exists)';
  END IF;
END $$;

-- @step cities
-- dietly's city ids are GUS SIMC codes; names repeat (seven Józefów in
-- Mazowieckie alone), so keep what tells them apart.
ALTER TABLE cities
  ADD COLUMN county_name VARCHAR(255),
  ADD COLUMN municipality_name VARCHAR(255),
  ADD COLUMN largest_city_for_name BOOLEAN,
  ADD COLUMN tracked BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN last_refreshed_at TIMESTAMPTZ;
UPDATE cities SET tracked = TRUE
 WHERE city_id IN (SELECT city_id FROM company_cities);

-- @step memberships
ALTER TABLE company_cities
  ADD COLUMN first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN price_city_id BIGINT REFERENCES cities;
UPDATE company_cities cc
   SET first_seen_at = COALESCE(h.first_seen, cc.first_seen_at),
       last_seen_at  = COALESCE(h.last_seen, cc.last_seen_at),
       price_city_id = cc.city_id
  FROM (SELECT company_id, city_id,
               min(first_seen_at) AS first_seen, max(last_seen_at) AS last_seen
          FROM company_city_history GROUP BY 1, 2) h
 WHERE h.company_id = cc.company_id AND h.city_id = cc.city_id;
UPDATE company_cities SET price_city_id = city_id WHERE price_city_id IS NULL;
CREATE INDEX company_cities_active_city
  ON company_cities (city_id, company_id) WHERE is_active;

-- @step home-cities
ALTER TABLE companies ADD COLUMN home_city_id BIGINT REFERENCES cities;
UPDATE companies co
   SET home_city_id = cc.city_id
  FROM (SELECT DISTINCT ON (company_id) company_id, city_id
          FROM company_cities ORDER BY company_id, city_id) cc
 WHERE cc.company_id = co.company_id;

-- @step city-quotes
-- price_history as seen from one city. A city whose advertised prices match
-- the home city's borrows the home city's quotes; the delivery fee in
-- total_cost / total_delivery_cost is swapped for this city's advertised fee
-- (a NULL fee quotes as 0 — 83 of 85 caterings with no advertised fee quote
-- 0 delivery). When the city is its own price city the delta is 0 and the
-- quote is returned exactly as dietly gave it. Returns closed spans too, so
-- price-history charts work; callers add `closed_at IS NULL` for current.
--
-- LANGUAGE sql + STABLE + a single SELECT lets the planner inline it, so a
-- caller's predicates reach the price_history indexes.
CREATE FUNCTION city_quotes(p_city_id BIGINT)
RETURNS TABLE (
  id BIGINT,
  company_id VARCHAR(255),
  diet_calories_id INT,
  tier_id INT,
  city_id BIGINT,
  quoted_city_id BIGINT,
  order_days INT,
  promo_codes TEXT[],
  per_day_cost NUMERIC(10,2),
  total_cost NUMERIC(10,2),
  total_cost_without_discounts NUMERIC(10,2),
  total_lowest_30days_cost_without_discounts NUMERIC(10,2),
  total_delivery_cost NUMERIC(10,2),
  total_delivery_discount NUMERIC(10,2),
  total_promo_code_discount NUMERIC(10,2),
  total_promo_code_discount_info TEXT,
  total_order_length_discount NUMERIC(10,2),
  total_deliveries_on_date_discount NUMERIC(10,2),
  total_loyalty_points_discount NUMERIC(10,2),
  total_pickup_point_discount NUMERIC(10,2),
  total_one_time_side_orders_cost NUMERIC(10,2),
  total_awarded_loyalty_program_points INT,
  total_awarded_global_loyalty_program_points INT,
  first_seen_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  observations INT,
  closed_at TIMESTAMPTZ
)
LANGUAGE sql STABLE AS $$
  SELECT h.id, h.company_id, h.diet_calories_id, h.tier_id,
         cc.city_id, h.city_id,
         h.order_days, h.promo_codes, h.per_day_cost,
         h.total_cost
           + (COALESCE(cc.delivery_fee, 0) - COALESCE(qc.delivery_fee, 0)) * h.order_days,
         h.total_cost_without_discounts,
         h.total_lowest_30days_cost_without_discounts,
         h.total_delivery_cost
           + (COALESCE(cc.delivery_fee, 0) - COALESCE(qc.delivery_fee, 0)) * h.order_days,
         h.total_delivery_discount,
         h.total_promo_code_discount, h.total_promo_code_discount_info,
         h.total_order_length_discount, h.total_deliveries_on_date_discount,
         h.total_loyalty_points_discount, h.total_pickup_point_discount,
         h.total_one_time_side_orders_cost,
         h.total_awarded_loyalty_program_points,
         h.total_awarded_global_loyalty_program_points,
         h.first_seen_at, h.last_seen_at, h.observations, h.closed_at
    FROM company_cities cc
    JOIN price_history h
      ON h.company_id = cc.company_id AND h.city_id = cc.price_city_id
    LEFT JOIN company_cities qc
      ON qc.company_id = h.company_id AND qc.city_id = h.city_id
   WHERE cc.city_id = p_city_id AND cc.is_active
$$;
