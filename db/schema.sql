-- ── Extensions ────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── Geography & companies (no history) ───────────────────────────────────
CREATE TABLE cities (
  city_id BIGINT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  sanitized_name VARCHAR(255),
  province_name VARCHAR(255),
  number_of_companies INT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE companies (
  company_id VARCHAR(255) PRIMARY KEY,
  name VARCHAR(255),
  logo_url TEXT,
  avg_score NUMERIC(5,2),
  feedback_value NUMERIC(4,2),
  feedback_number INT,
  awarded BOOLEAN DEFAULT FALSE,
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
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE company_cities (
  company_id VARCHAR(255) NOT NULL REFERENCES companies ON DELETE CASCADE,
  city_id BIGINT NOT NULL REFERENCES cities ON DELETE CASCADE,
  delivery_fee NUMERIC(10,2),
  lowest_price_standard NUMERIC(10,2),
  lowest_price_menu_config NUMERIC(10,2),
  orders_enabled BOOLEAN,
  delivery_enabled BOOLEAN,
  order_possible_on DATE,
  order_possible_to TIMESTAMPTZ,
  PRIMARY KEY (company_id, city_id)
);

-- ── Diet hierarchy (drift-tracked) ───────────────────────────────────────
-- Pattern: canonical row mutable; companion *_snapshots append on fingerprint change.
-- All catalog tables carry: fingerprint, first_seen_at, last_seen_at, is_active.
-- is_active flips false when a scrape doesn't see the entity; flipped back on reappearance.

CREATE TABLE diet_tags (
  tag_code VARCHAR(100) PRIMARY KEY,
  label VARCHAR(255),
  description TEXT
);

CREATE TABLE diets (
  company_id VARCHAR(255) NOT NULL REFERENCES companies ON DELETE CASCADE,
  diet_id INT NOT NULL,
  name VARCHAR(255),
  description TEXT,
  diet_tag VARCHAR(100) REFERENCES diet_tags,
  is_menu_configuration BOOLEAN DEFAULT FALSE,
  diet_meal_count INT,
  awarded BOOLEAN DEFAULT FALSE,
  avg_score NUMERIC(5,2),
  feedback_value NUMERIC(4,2),
  feedback_number INT,
  fingerprint TEXT,
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ DEFAULT NOW(),
  is_active     BOOLEAN DEFAULT TRUE,
  PRIMARY KEY (company_id, diet_id)
);

CREATE TABLE diet_snapshots (
  id BIGSERIAL PRIMARY KEY,
  company_id VARCHAR(255) NOT NULL, diet_id INT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fingerprint TEXT NOT NULL,
  name VARCHAR(255), description TEXT, diet_tag VARCHAR(100),
  is_menu_configuration BOOLEAN, diet_meal_count INT,
  awarded BOOLEAN, avg_score NUMERIC(5,2),
  feedback_value NUMERIC(4,2), feedback_number INT,
  FOREIGN KEY (company_id, diet_id) REFERENCES diets ON DELETE CASCADE
);
CREATE INDEX ON diet_snapshots (company_id, diet_id, captured_at DESC);

CREATE TABLE tiers (
  company_id VARCHAR(255) NOT NULL,
  diet_id INT NOT NULL,
  tier_id INT NOT NULL,
  name VARCHAR(255),
  meals_number INT,
  tag VARCHAR(100),
  fingerprint TEXT,
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ DEFAULT NOW(),
  is_active     BOOLEAN DEFAULT TRUE,
  PRIMARY KEY (company_id, diet_id, tier_id),
  FOREIGN KEY (company_id, diet_id) REFERENCES diets ON DELETE CASCADE
);

CREATE TABLE tier_snapshots (
  id BIGSERIAL PRIMARY KEY,
  company_id VARCHAR(255) NOT NULL, diet_id INT NOT NULL, tier_id INT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fingerprint TEXT NOT NULL,
  name VARCHAR(255), meals_number INT, tag VARCHAR(100),
  FOREIGN KEY (company_id, diet_id, tier_id) REFERENCES tiers ON DELETE CASCADE
);
CREATE INDEX ON tier_snapshots (company_id, diet_id, tier_id, captured_at DESC);

CREATE TABLE diet_options (
  company_id VARCHAR(255) NOT NULL,
  diet_id INT NOT NULL,
  tier_id INT NOT NULL,
  diet_option_id INT NOT NULL,
  tier_diet_option_id VARCHAR(50),
  name VARCHAR(255),
  diet_option_tag VARCHAR(100),
  is_default BOOLEAN,
  fingerprint TEXT,
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ DEFAULT NOW(),
  is_active     BOOLEAN DEFAULT TRUE,
  PRIMARY KEY (company_id, diet_id, tier_id, diet_option_id),
  FOREIGN KEY (company_id, diet_id, tier_id) REFERENCES tiers ON DELETE CASCADE
);

CREATE TABLE diet_option_snapshots (
  id BIGSERIAL PRIMARY KEY,
  company_id VARCHAR(255) NOT NULL, diet_id INT NOT NULL,
  tier_id INT NOT NULL, diet_option_id INT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fingerprint TEXT NOT NULL,
  name VARCHAR(255), diet_option_tag VARCHAR(100), is_default BOOLEAN,
  FOREIGN KEY (company_id, diet_id, tier_id, diet_option_id) REFERENCES diet_options ON DELETE CASCADE
);
CREATE INDEX ON diet_option_snapshots (company_id, diet_id, tier_id, diet_option_id, captured_at DESC);

CREATE TABLE diet_calories (
  diet_calories_id INT PRIMARY KEY,
  company_id VARCHAR(255) NOT NULL,
  diet_id INT NOT NULL,
  tier_id INT NOT NULL,
  diet_option_id INT NOT NULL,
  calories INT NOT NULL,
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ DEFAULT NOW(),
  is_active     BOOLEAN DEFAULT TRUE,
  FOREIGN KEY (company_id, diet_id, tier_id, diet_option_id)
    REFERENCES diet_options ON DELETE CASCADE
);
-- No diet_calories_snapshots — calories rarely drift; existence drift is captured by is_active + last_seen_at.

CREATE TABLE diet_discounts (
  id BIGSERIAL PRIMARY KEY,
  company_id VARCHAR(255) NOT NULL,
  diet_id INT NOT NULL,
  discount NUMERIC(6,2) NOT NULL,
  minimum_days INT NOT NULL,
  discount_type VARCHAR(50) NOT NULL,         -- PERCENTAGE / FIXED
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ DEFAULT NOW(),
  is_active     BOOLEAN DEFAULT TRUE,
  FOREIGN KEY (company_id, diet_id) REFERENCES diets ON DELETE CASCADE,
  UNIQUE (company_id, diet_id, minimum_days, discount_type)
);

-- Full discount table snapshot per (company, diet) drift; one row per drift.
CREATE TABLE diet_discount_snapshots (
  id BIGSERIAL PRIMARY KEY,
  company_id VARCHAR(255) NOT NULL, diet_id INT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fingerprint TEXT NOT NULL,
  discounts JSONB NOT NULL                    -- [{discount, minimum_days, discount_type}, ...]
);
CREATE INDEX ON diet_discount_snapshots (company_id, diet_id, captured_at DESC);

-- ── Prices — every component of every quote, every scrape ────────────────
CREATE TABLE prices (
  id BIGSERIAL PRIMARY KEY,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  diet_calories_id INT NOT NULL REFERENCES diet_calories ON DELETE CASCADE,
  company_id VARCHAR(255) NOT NULL,
  city_id BIGINT NOT NULL REFERENCES cities,
  order_days INT NOT NULL,
  promo_codes TEXT[] DEFAULT '{}',
  -- Per-day numbers (the comparable headline rate)
  per_day_cost                NUMERIC(10,2),
  per_day_cost_with_discounts NUMERIC(10,2),
  -- Totals
  total_cost                  NUMERIC(10,2),  -- = totalCostToPay
  total_cost_without_discounts NUMERIC(10,2),
  total_lowest_30days_cost_without_discounts NUMERIC(10,2), -- Omnibus reference
  -- Delivery
  total_delivery_cost         NUMERIC(10,2),
  total_delivery_discount     NUMERIC(10,2),
  -- Promo / order length / loyalty / pickup
  total_promo_code_discount   NUMERIC(10,2),
  total_promo_code_discount_info TEXT,
  total_order_length_discount NUMERIC(10,2),
  total_deliveries_on_date_discount NUMERIC(10,2),
  total_loyalty_points_discount NUMERIC(10,2),
  total_pickup_point_discount NUMERIC(10,2),
  -- Side orders
  total_one_time_side_orders_cost NUMERIC(10,2),
  -- Awarded points (denormalised metadata; cheap to keep)
  total_awarded_loyalty_program_points        INT,
  total_awarded_global_loyalty_program_points INT
);
CREATE INDEX ON prices (diet_calories_id, order_days, captured_at DESC);
CREATE INDEX ON prices (company_id, city_id, captured_at DESC);
CREATE INDEX ON prices (captured_at DESC);

-- ── Campaigns (mutable; no history) ───────────────────────────────────────
CREATE TABLE campaigns (
  id BIGSERIAL PRIMARY KEY,
  company_id VARCHAR(255) REFERENCES companies,
  code VARCHAR(100),
  title VARCHAR(255),
  discount_percent NUMERIC(5,2),
  starts_at DATE,
  ends_at DATE,
  is_active BOOLEAN DEFAULT TRUE,
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, code)
);

-- ── Meals (canonical dishes per company, drift-tracked) ──────────────────
CREATE TABLE meals (
  id BIGSERIAL PRIMARY KEY,
  company_id VARCHAR(255) NOT NULL REFERENCES companies ON DELETE CASCADE,
  name TEXT NOT NULL,
  label VARCHAR(255),
  thermo VARCHAR(20),
  kcal NUMERIC(7,2),
  protein_g NUMERIC(7,2),
  fat_g NUMERIC(7,2),
  carbs_g NUMERIC(7,2),
  fiber_g NUMERIC(7,2),
  sugar_g NUMERIC(7,2),
  saturated_fat_g NUMERIC(7,2),
  salt_g NUMERIC(7,2),
  image_url TEXT,
  reviews_score NUMERIC(5,2),
  reviews_number INT,
  allergens TEXT[],                 -- normalized dietlyAllergenName
  ingredients_raw TEXT,             -- preserved verbatim (embedding source + forensics)
  fingerprint TEXT,                 -- hash; drift detection + re-embed trigger
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, name)
);
CREATE INDEX ON meals (company_id, lower(name));
CREATE INDEX ON meals USING gin (allergens);
CREATE INDEX ON meals USING gin (ingredients_raw gin_trgm_ops);

CREATE TABLE meals_history (
  id BIGSERIAL PRIMARY KEY,
  meal_id BIGINT NOT NULL REFERENCES meals ON DELETE CASCADE,
  captured_at TIMESTAMPTZ DEFAULT NOW(),
  fingerprint TEXT,
  kcal NUMERIC(7,2),
  protein_g NUMERIC(7,2),
  fat_g NUMERIC(7,2),
  carbs_g NUMERIC(7,2),
  fiber_g NUMERIC(7,2),
  sugar_g NUMERIC(7,2),
  saturated_fat_g NUMERIC(7,2),
  salt_g NUMERIC(7,2),
  reviews_score NUMERIC(5,2),
  reviews_number INT
);
CREATE INDEX ON meals_history (meal_id, captured_at DESC);

-- ── Structured ingredients (current rows + JSONB snapshots on drift) ─────
CREATE TABLE meal_ingredients (
  id BIGSERIAL PRIMARY KEY,
  meal_id BIGINT NOT NULL REFERENCES meals ON DELETE CASCADE,
  position INT NOT NULL,
  name_raw TEXT NOT NULL,
  name_normalized TEXT NOT NULL,
  is_major BOOLEAN DEFAULT FALSE
);
CREATE INDEX ON meal_ingredients (meal_id);
CREATE INDEX ON meal_ingredients (name_normalized);
CREATE INDEX ON meal_ingredients USING gin (name_normalized gin_trgm_ops);

CREATE TABLE meal_ingredients_snapshots (
  id BIGSERIAL PRIMARY KEY,
  meal_id BIGINT NOT NULL REFERENCES meals ON DELETE CASCADE,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fingerprint TEXT NOT NULL,        -- meal.fingerprint at capture
  ingredients JSONB NOT NULL        -- [{position, name_raw, name_normalized, is_major}, ...]
);
CREATE INDEX ON meal_ingredients_snapshots (meal_id, captured_at DESC);

-- ── Ingredient taxonomy (psiankowate, strączkowe, ...) ───────────────────
CREATE TABLE ingredient_taxonomy (
  category VARCHAR(100) PRIMARY KEY,
  label    VARCHAR(255),
  description TEXT
);

CREATE TABLE ingredient_taxonomy_members (
  category VARCHAR(100) NOT NULL REFERENCES ingredient_taxonomy ON DELETE CASCADE,
  ingredient_pattern TEXT NOT NULL,  -- lowercase substring/prefix
  PRIMARY KEY (category, ingredient_pattern)
);

-- ── Daily menu (event log — every observation) ────────────────────────────
CREATE TABLE daily_menu (
  id BIGSERIAL PRIMARY KEY,
  captured_at TIMESTAMPTZ DEFAULT NOW(),
  company_id VARCHAR(255) NOT NULL REFERENCES companies ON DELETE CASCADE,
  city_id BIGINT NOT NULL REFERENCES cities,
  diet_calories_id INT NOT NULL,
  tier_id INT,
  menu_date DATE NOT NULL,
  slot_name VARCHAR(80),
  meal_id BIGINT REFERENCES meals ON DELETE SET NULL,
  api_meal_slot_id BIGINT,
  is_default BOOLEAN
);
CREATE INDEX ON daily_menu (company_id, menu_date, diet_calories_id, captured_at DESC);
CREATE INDEX ON daily_menu (meal_id, menu_date);

-- Latest-snapshot dedup view for scoring queries
CREATE OR REPLACE VIEW current_daily_menu AS
SELECT DISTINCT ON (
  company_id, city_id, diet_calories_id, COALESCE(tier_id, -1),
  menu_date, slot_name, COALESCE(meal_id, -1)
) *
FROM daily_menu
ORDER BY
  company_id, city_id, diet_calories_id, COALESCE(tier_id, -1),
  menu_date, slot_name, COALESCE(meal_id, -1),
  captured_at DESC;

-- ── Vector table (e5-small; multi-version per meal) ──────────────────────
-- 384 dims matches Xenova/multilingual-e5-small. If the production model
-- changes, update this AND the τ/divisor constants in lib/queries.ts. See
-- EMBEDDINGS.md for the calibration story.
CREATE TABLE meal_embeddings (
  meal_id BIGINT NOT NULL REFERENCES meals ON DELETE CASCADE,
  embedded_fp TEXT NOT NULL,
  embedding vector(384) NOT NULL,
  embedded_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (meal_id, embedded_fp)
);
CREATE INDEX ON meal_embeddings USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON meal_embeddings (meal_id, embedded_at DESC);

CREATE OR REPLACE VIEW current_meal_embeddings AS
SELECT DISTINCT ON (meal_id) *
FROM meal_embeddings
ORDER BY meal_id, embedded_at DESC;

-- ── Keyword embedding cache (ephemeral) ───────────────────────────────────
CREATE TABLE keyword_embeddings (
  keyword TEXT PRIMARY KEY,
  embedding vector(384) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ON keyword_embeddings (last_used_at DESC);
