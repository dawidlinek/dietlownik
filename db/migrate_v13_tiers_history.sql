-- v13: tier-aware catalog leaves, history for catering settings, campaigns
-- and dish photos, and an ingredient-name dictionary.
--
-- Run through `node db/migrate_v13_tiers_history.js` (one transaction).
--
-- 1. Tier-aware leaves. 64 of 165 caterings reuse one dietCaloriesId across
--    the tiers (meal-count packages) of a menu-configuration diet — verified
--    2026-09-23 against every live catalog: 1,833 ids, always same diet and
--    option, different tier, never twice in one tier. The old key
--    (company_id, diet_calories_id) kept one tier per id, so the other
--    packages were never priced or menu-scraped. The leaf is now
--    (company_id, diet_calories_id, tier_id).
--    History recorded before this was for whichever tier the catalog had
--    kept at the time: menu_items always stored that tier; price_history
--    gets the tier the catalog holds now (the kept tier only changed for 18
--    leaves, all visible in menu_items, which are planted below).
-- 2. company_history, campaign_history: spans of catering settings and
--    promo-code terms, seeded with the current values as one observation at
--    their last-seen time.
-- 3. menu_items.image_url: the dish photo each option showed. Open spans are
--    seeded with the dish's last-known photo so the next scrape extends them
--    instead of splitting every span; closed spans stay NULL (unknown).
-- 4. Ingredient dictionary: 4.67M ingredient rows use 14k distinct names.
--    Names move to ingredient_names; variant_ingredients references them;
--    `meal_ingredients` becomes a view with the old columns, so readers are
--    unchanged.
-- 5. Coverage of what dietly returns (audit 2026-09-23): catering contact,
--    address, capability flags and review %, per-city delivery windows,
--    advertised per-diet prices, paid side orders, tier descriptions and
--    "from" prices, tier-level discount ladders, exact promo validity,
--    diet-tag descriptions, dietly's ingredient-exclusion ids and allergen
--    details. Empty-string photos become NULL; unknown leaf kcal becomes NULL
--    instead of 0.

-- @step preflight
DO $$
BEGIN
  IF to_regclass('public.menu_items') IS NULL THEN
    RAISE EXCEPTION 'v11 not applied (menu_items missing)';
  END IF;
  IF to_regclass('public.variant_ingredients') IS NOT NULL THEN
    RAISE EXCEPTION 'v13 already applied (variant_ingredients exists)';
  END IF;
  IF to_regclass('public.company_city_history') IS NULL THEN
    RAISE EXCEPTION 'v12 not applied (company_city_history missing)';
  END IF;
END $$;

-- @step tier-leaves
ALTER TABLE price_history DROP CONSTRAINT price_history_company_id_diet_calories_id_fkey;
ALTER TABLE menu_items DROP CONSTRAINT menu_items_company_id_diet_calories_id_fkey;
ALTER TABLE diet_calories DROP CONSTRAINT diet_calories_pkey;
ALTER TABLE diet_calories ADD PRIMARY KEY (company_id, diet_calories_id, tier_id);

-- Leaves that menu history recorded under a tier the collapsed catalog no
-- longer listed for that id. Planted inactive (with any missing tier/option
-- parent) so the history keeps a valid key; the next catalog scrape
-- reactivates whatever still exists.
CREATE TEMP TABLE orphan_leaves AS
SELECT DISTINCT mi.company_id, mi.diet_calories_id, mi.tier_id,
       dc.diet_id, dc.diet_option_id, dc.calories
FROM menu_items mi
JOIN diet_calories dc
  ON dc.company_id = mi.company_id AND dc.diet_calories_id = mi.diet_calories_id
WHERE NOT EXISTS (
  SELECT 1 FROM diet_calories x
  WHERE x.company_id = mi.company_id AND x.diet_calories_id = mi.diet_calories_id
    AND x.tier_id = mi.tier_id);
INSERT INTO tiers (company_id, diet_id, tier_id, is_active)
SELECT DISTINCT company_id, diet_id, tier_id, FALSE FROM orphan_leaves
ON CONFLICT DO NOTHING;
INSERT INTO diet_options (company_id, diet_id, tier_id, diet_option_id, is_active)
SELECT DISTINCT company_id, diet_id, tier_id, diet_option_id, FALSE FROM orphan_leaves
ON CONFLICT DO NOTHING;
INSERT INTO diet_calories
  (diet_calories_id, company_id, diet_id, tier_id, diet_option_id, calories,
   first_seen_at, last_seen_at, is_active)
SELECT o.diet_calories_id, o.company_id, o.diet_id, o.tier_id, o.diet_option_id,
       o.calories, h.first_at, h.last_at, FALSE
FROM orphan_leaves o
CROSS JOIN LATERAL (
  SELECT min(first_seen_at) AS first_at, max(last_seen_at) AS last_at
  FROM menu_items mi
  WHERE mi.company_id = o.company_id AND mi.diet_calories_id = o.diet_calories_id
    AND mi.tier_id = o.tier_id
) h;

ALTER TABLE price_history ADD COLUMN tier_id INT;
UPDATE price_history h
SET tier_id = dc.tier_id
FROM diet_calories dc
WHERE dc.company_id = h.company_id AND dc.diet_calories_id = h.diet_calories_id
  AND dc.is_active;
-- Ids whose only leaves are the inactive ones planted above.
UPDATE price_history h
SET tier_id = (SELECT min(dc.tier_id) FROM diet_calories dc
               WHERE dc.company_id = h.company_id
                 AND dc.diet_calories_id = h.diet_calories_id)
WHERE h.tier_id IS NULL;
ALTER TABLE price_history ALTER COLUMN tier_id SET NOT NULL;

ALTER TABLE price_history
  ADD FOREIGN KEY (company_id, diet_calories_id, tier_id)
  REFERENCES diet_calories ON DELETE CASCADE;
ALTER TABLE menu_items
  ADD FOREIGN KEY (company_id, diet_calories_id, tier_id)
  REFERENCES diet_calories ON DELETE CASCADE;

DROP INDEX price_history_open_key;
CREATE UNIQUE INDEX price_history_open_key
  ON price_history (company_id, diet_calories_id, tier_id, city_id, order_days, promo_codes)
  WHERE closed_at IS NULL;
DROP INDEX price_history_open_city;
CREATE INDEX price_history_open_city
  ON price_history (city_id, company_id, diet_calories_id, tier_id)
  WHERE closed_at IS NULL;
DROP INDEX price_history_series;
CREATE INDEX price_history_series
  ON price_history (company_id, diet_calories_id, tier_id, city_id, first_seen_at);

-- @step company-history
CREATE TABLE company_history (
  id BIGSERIAL PRIMARY KEY,
  company_id VARCHAR(255) NOT NULL REFERENCES companies ON DELETE CASCADE,
  name VARCHAR(255),
  logo_url TEXT,
  awarded BOOLEAN,
  price_category VARCHAR(20),
  delivery_on_saturday BOOLEAN,
  delivery_on_sunday BOOLEAN,
  menu_enabled BOOLEAN,
  menu_days_ahead INT,
  orders_enabled BOOLEAN,
  delivery_enabled BOOLEAN,
  delivery_info_text TEXT,
  delivery_info_date DATE,
  dietly_delivery BOOLEAN,
  recently_added BOOLEAN,
  invite_code_discount_percent NUMERIC(5,2),
  nutrition_visible BOOLEAN,
  ingredients_visible BOOLEAN,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  observations  INT NOT NULL DEFAULT 1 CHECK (observations > 0),
  closed_at     TIMESTAMPTZ,
  CHECK (last_seen_at >= first_seen_at),
  CHECK (closed_at IS NULL OR closed_at >= last_seen_at)
);
CREATE UNIQUE INDEX company_history_open_key
  ON company_history (company_id) WHERE closed_at IS NULL;
CREATE INDEX company_history_series ON company_history (company_id, first_seen_at);
INSERT INTO company_history
  (company_id, name, logo_url, awarded, price_category, delivery_on_saturday,
   delivery_on_sunday, menu_enabled, menu_days_ahead, orders_enabled,
   delivery_enabled, delivery_info_text, delivery_info_date, dietly_delivery,
   recently_added, invite_code_discount_percent, nutrition_visible,
   ingredients_visible, first_seen_at, last_seen_at)
-- awarded is seeded unknown: the scraper read a field the API never sends,
-- so every stored value was FALSE regardless of the truth.
SELECT company_id, name, logo_url, NULL::boolean, price_category, delivery_on_saturday,
       delivery_on_sunday, menu_enabled, menu_days_ahead, orders_enabled,
       delivery_enabled, delivery_info_text, delivery_info_date, dietly_delivery,
       recently_added, invite_code_discount_percent, nutrition_visible,
       ingredients_visible, COALESCE(updated_at, NOW()), COALESCE(updated_at, NOW())
FROM companies;

-- @step campaign-history
CREATE TABLE campaign_history (
  id BIGSERIAL PRIMARY KEY,
  company_id VARCHAR(255) REFERENCES companies ON DELETE CASCADE,
  code VARCHAR(100),
  title VARCHAR(255),
  discount_percent NUMERIC(5,2),
  starts_at DATE,
  ends_at DATE,
  is_active BOOLEAN,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  observations  INT NOT NULL DEFAULT 1 CHECK (observations > 0),
  closed_at     TIMESTAMPTZ,
  CHECK (last_seen_at >= first_seen_at),
  CHECK (closed_at IS NULL OR closed_at >= last_seen_at)
);
CREATE UNIQUE INDEX campaign_history_open_key
  ON campaign_history (company_id, code) NULLS NOT DISTINCT
  WHERE closed_at IS NULL;
CREATE INDEX campaign_history_series ON campaign_history (company_id, code, first_seen_at);
INSERT INTO campaign_history
  (company_id, code, title, discount_percent, starts_at, ends_at, is_active,
   first_seen_at, last_seen_at)
SELECT company_id, code, title, discount_percent, starts_at, ends_at, is_active,
       COALESCE(last_seen_at, NOW()), COALESCE(last_seen_at, NOW())
FROM campaigns;

-- @step menu-image
ALTER TABLE menu_items ADD COLUMN image_url TEXT;
UPDATE menu_items mi
SET image_url = m.image_url
FROM meals m
WHERE m.id = mi.meal_id AND mi.closed_at IS NULL AND m.image_url IS NOT NULL;
DROP VIEW current_menu_items;
CREATE VIEW current_menu_items AS
SELECT * FROM menu_items WHERE closed_at IS NULL;

-- @step ingredient-dictionary
CREATE TABLE ingredient_names (
  id SERIAL PRIMARY KEY,
  name_raw TEXT NOT NULL UNIQUE,
  name_normalized TEXT NOT NULL
);
INSERT INTO ingredient_names (name_raw, name_normalized)
SELECT name_raw, min(name_normalized)
FROM meal_ingredients
GROUP BY name_raw
ORDER BY name_raw;
CREATE TABLE variant_ingredients (
  variant_id BIGINT NOT NULL REFERENCES meal_variants ON DELETE CASCADE,
  position INT NOT NULL,
  name_id INT NOT NULL REFERENCES ingredient_names,
  is_major BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (variant_id, position)
);
INSERT INTO variant_ingredients (variant_id, position, name_id, is_major)
SELECT mi.variant_id, mi.position, n.id, mi.is_major
FROM meal_ingredients mi
JOIN ingredient_names n ON n.name_raw = mi.name_raw;
DO $$
BEGIN
  IF (SELECT count(*) FROM variant_ingredients) <> (SELECT count(*) FROM meal_ingredients) THEN
    RAISE EXCEPTION 'ingredient dictionary lost rows';
  END IF;
END $$;
DROP TABLE meal_ingredients;
CREATE INDEX ON variant_ingredients (name_id);
CREATE INDEX ON ingredient_names USING gin (name_normalized gin_trgm_ops);
-- The old shape, for every reader (ranking, bench, verification queries).
CREATE VIEW meal_ingredients AS
SELECT vi.variant_id, vi.position, n.name_raw, n.name_normalized, vi.is_major
FROM variant_ingredients vi
JOIN ingredient_names n ON n.id = vi.name_id;

-- @step coverage
ALTER TABLE companies
  ADD COLUMN description TEXT,
  ADD COLUMN email TEXT,
  ADD COLUMN phone TEXT,
  ADD COLUMN address JSONB,
  ADD COLUMN delivery_cities_count INT,
  ADD COLUMN params JSONB,
  ADD COLUMN positive_meals_review_percent INT;
ALTER TABLE company_history
  ADD COLUMN description TEXT,
  ADD COLUMN email TEXT,
  ADD COLUMN phone TEXT,
  ADD COLUMN address JSONB,
  ADD COLUMN delivery_cities_count INT,
  ADD COLUMN params JSONB,
  ADD COLUMN positive_meals_review_percent INT;

ALTER TABLE company_cities ADD COLUMN delivery_times JSONB;
ALTER TABLE company_city_history ADD COLUMN delivery_times JSONB;

ALTER TABLE tiers ADD COLUMN description TEXT, ADD COLUMN min_price NUMERIC(10,2);
ALTER TABLE tier_snapshots ADD COLUMN description TEXT, ADD COLUMN min_price NUMERIC(10,2);

ALTER TABLE diet_discounts ADD COLUMN tier_id INT NOT NULL DEFAULT 0;
-- The old unique constraint's auto-generated name is truncated at 63 chars;
-- find it by definition instead.
DO $$
DECLARE c TEXT;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'diet_discounts'::regclass AND contype = 'u';
  EXECUTE format('ALTER TABLE diet_discounts DROP CONSTRAINT %I', c);
END $$;
ALTER TABLE diet_discounts
  ADD CONSTRAINT diet_discounts_ladder_key
  UNIQUE (company_id, diet_id, tier_id, minimum_days, discount_type);

ALTER TABLE diet_calories ALTER COLUMN calories DROP NOT NULL;
UPDATE diet_calories SET calories = NULL WHERE calories = 0;

ALTER TABLE campaigns
  ADD COLUMN valid_from TIMESTAMPTZ,
  ADD COLUMN valid_to TIMESTAMPTZ,
  ADD COLUMN separate BOOLEAN;
ALTER TABLE campaign_history
  ADD COLUMN valid_from TIMESTAMPTZ,
  ADD COLUMN valid_to TIMESTAMPTZ,
  ADD COLUMN separate BOOLEAN;

ALTER TABLE diet_tags ADD COLUMN similar_tags TEXT[];

CREATE TABLE dietary_exclusions (
  exclusion_id INT PRIMARY KEY,
  name TEXT NOT NULL
);
ALTER TABLE variant_ingredients ADD COLUMN exclusion_ids INT[];
ALTER TABLE meal_variants ADD COLUMN allergens_detail JSONB;

CREATE TABLE diet_advertised_prices (
  id BIGSERIAL PRIMARY KEY,
  company_id VARCHAR(255) NOT NULL REFERENCES companies ON DELETE CASCADE,
  city_id BIGINT NOT NULL REFERENCES cities ON DELETE CASCADE,
  diet_id INT NOT NULL,
  default_price NUMERIC(10,2),
  discount_price NUMERIC(10,2),
  in_promotion BOOLEAN,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  observations  INT NOT NULL DEFAULT 1 CHECK (observations > 0),
  closed_at     TIMESTAMPTZ,
  CHECK (last_seen_at >= first_seen_at),
  CHECK (closed_at IS NULL OR closed_at >= last_seen_at)
);
CREATE UNIQUE INDEX diet_advertised_prices_open_key
  ON diet_advertised_prices (company_id, city_id, diet_id) WHERE closed_at IS NULL;
CREATE INDEX diet_advertised_prices_series
  ON diet_advertised_prices (company_id, diet_id, city_id, first_seen_at);

CREATE TABLE company_side_orders (
  id BIGSERIAL PRIMARY KEY,
  company_id VARCHAR(255) NOT NULL REFERENCES companies ON DELETE CASCADE,
  name TEXT NOT NULL,
  price NUMERIC(10,2),
  image_url TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  observations  INT NOT NULL DEFAULT 1 CHECK (observations > 0),
  closed_at     TIMESTAMPTZ,
  CHECK (last_seen_at >= first_seen_at),
  CHECK (closed_at IS NULL OR closed_at >= last_seen_at)
);
CREATE UNIQUE INDEX company_side_orders_open_key
  ON company_side_orders (company_id, name) WHERE closed_at IS NULL;
CREATE INDEX company_side_orders_series
  ON company_side_orders (company_id, name, first_seen_at);

UPDATE meals SET image_url = NULL WHERE image_url = '';
UPDATE menu_items SET image_url = NULL WHERE image_url = '';

-- @step analyze
ANALYZE diet_calories;
ANALYZE price_history;
ANALYZE menu_items;
ANALYZE company_history;
ANALYZE campaign_history;
ANALYZE ingredient_names;
ANALYZE variant_ingredients;
