-- v15: menus are national — menu_items loses city_id.
--
-- Run through `node db/migrate_v15_national_menus.js` (one transaction).
--
-- `bun run check:cities` compared menus across cities on 2026-09-22: 0 of
-- 435 (catering, city) pairs differed in dish lineup or dish content, across
-- all 16 voivodeship capitals plus villages (see CLAUDE.md "City scope"). A
-- menu belongs to the catering, not to the city it ships to, so menu_items
-- stops keeping one copy per city. The menus scraper still names a city in
-- the URL — the API requires one — but which city no longer changes what is
-- stored. Which caterings a city can order from is company_cities.
--
-- Prices are NOT made national here: ~5% of caterings price by city
-- (price_history keeps city_id).
--
-- Refuses a database holding menus for more than one city: collapsing
-- per-city copies into one span per option would need a merge decision, not
-- a silent pick.

-- @step preflight
DO $$
DECLARE
  n_cities INT;
BEGIN
  IF to_regclass('public.variant_ingredients') IS NULL THEN
    RAISE EXCEPTION 'v13 not applied (variant_ingredients missing)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'menu_items'
                    AND column_name = 'city_id') THEN
    RAISE EXCEPTION 'v15 already applied (menu_items.city_id missing)';
  END IF;
  SELECT count(DISTINCT city_id) INTO n_cities FROM menu_items;
  IF n_cities > 1 THEN
    RAISE EXCEPTION 'menu_items holds menus for % cities; v15 expects at most one', n_cities;
  END IF;
END $$;

-- @step drop-city
-- The view is SELECT *, so it pins every column; recreated below. Dropping
-- the column also drops its foreign key to cities.
DROP VIEW current_menu_items;
DROP INDEX menu_items_open_key;
DROP INDEX menu_items_open_city_date;
ALTER TABLE menu_items DROP COLUMN city_id;

-- @step indexes
-- Writer: all open options of one fetched menu; one open span per option.
CREATE UNIQUE INDEX menu_items_open_key
  ON menu_items (company_id, diet_calories_id, tier_id, menu_date, api_meal_slot_id)
  WHERE closed_at IS NULL;
-- Ranking hot path: every current option for a day (the city filter is a
-- company_cities join).
CREATE INDEX menu_items_open_date
  ON menu_items (menu_date, company_id, diet_calories_id)
  WHERE closed_at IS NULL;
CREATE VIEW current_menu_items AS
SELECT * FROM menu_items WHERE closed_at IS NULL;
ANALYZE menu_items;
