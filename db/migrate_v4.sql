-- v4: time-series migration
--   1. diet_calories: composite key so the same dietCaloriesId can live under
--      multiple (tier, option) combos (verified: same id, 3 different prices).
--   2. campaigns: drop is_active exclusivity, allow N concurrent codes.
--   3. promo_observations: append-only time-series of "code X attached to
--      company Y at time Z".
--   4. meals + meals_history + daily_menu: replace the empty
--      meal_options/meal_slots/menus tables with a time-series-friendly model.

-- ── 0. drop empty legacy tables that FK into diet_calories ────────────────────
-- Done first so we can rebuild diet_calories' PK without dependency errors.
DROP TABLE IF EXISTS meal_options CASCADE;
DROP TABLE IF EXISTS meal_slots   CASCADE;
DROP TABLE IF EXISTS menus        CASCADE;

-- ── 1. diet_calories: allow same id across tiers ──────────────────────────────

-- Drop the inbound FK from prices that pinned diet_calories_id as PK target.
ALTER TABLE prices
  DROP CONSTRAINT IF EXISTS prices_diet_calories_id_fkey;

-- Drop existing PK on (diet_calories_id) and rebuild as composite. We use a
-- surrogate row id PK and a unique constraint over the actual tree path.
ALTER TABLE diet_calories
  DROP CONSTRAINT IF EXISTS diet_calories_pkey;

ALTER TABLE diet_calories
  ADD COLUMN IF NOT EXISTS id BIGSERIAL;

ALTER TABLE diet_calories
  ADD CONSTRAINT diet_calories_pkey PRIMARY KEY (id);

-- Allow nullable tier/option for ready diets (already nullable from v3, but
-- assert it explicitly so the unique constraint can include them).
ALTER TABLE diet_calories
  ALTER COLUMN tier_id        DROP NOT NULL,
  ALTER COLUMN diet_option_id DROP NOT NULL;

-- Composite unique: one row per (kcal id, tier, option, diet, company).
-- NULLS NOT DISTINCT (PG 15+) treats NULL=NULL so ready diets dedupe correctly.
DROP INDEX IF EXISTS uq_diet_calories_tree;
CREATE UNIQUE INDEX uq_diet_calories_tree
  ON diet_calories (
    company_id,
    diet_id,
    diet_calories_id,
    COALESCE(tier_id, -1),
    COALESCE(diet_option_id, -1)
  );

-- Index for "which dietCaloriesIds are live for this company" lookups.
CREATE INDEX IF NOT EXISTS idx_diet_calories_company_active
  ON diet_calories (company_id) WHERE valid_to IS NULL;

-- ── 2. campaigns: drop is_active exclusivity, enrich shape ────────────────────

DROP INDEX IF EXISTS idx_campaigns_code_active;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS source     VARCHAR(40),    -- constant | awarded-and-top | banner | recommended-diets
  ADD COLUMN IF NOT EXISTS company_id VARCHAR(255) REFERENCES companies(company_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deadline   DATE,            -- promoDeadline (mobile)
  ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS valid_to   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS separate   BOOLEAN,
  ADD COLUMN IF NOT EXISTS deep_link  TEXT,
  ADD COLUMN IF NOT EXISTS target     VARCHAR(40);

-- One canonical row per (code, source, company_id). NULL company = global.
CREATE UNIQUE INDEX IF NOT EXISTS uq_campaigns_code_source_company
  ON campaigns (code, source, COALESCE(company_id, ''));

-- ── 3. promo_observations: append-only ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS promo_observations (
  id                BIGSERIAL PRIMARY KEY,
  captured_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  code              VARCHAR(100) NOT NULL,
  source            VARCHAR(40)  NOT NULL,
  company_id        VARCHAR(255) REFERENCES companies(company_id) ON DELETE SET NULL,
  city_id           BIGINT REFERENCES cities(city_id) ON DELETE SET NULL,
  discount_percents NUMERIC(5,2),
  promo_text        TEXT,
  deadline          DATE,
  separate          BOOLEAN,
  valid_from        TIMESTAMPTZ,
  valid_to          TIMESTAMPTZ,
  raw               JSONB
);
CREATE INDEX IF NOT EXISTS idx_promo_obs_captured ON promo_observations(captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_promo_obs_company  ON promo_observations(company_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_promo_obs_code     ON promo_observations(code, captured_at DESC);

-- ── 4. meals + meals_history + daily_menu ─────────────────────────────────────

CREATE TABLE meals (
  diet_calories_meal_id BIGINT PRIMARY KEY,            -- stable across days
  company_id            VARCHAR(255) REFERENCES companies(company_id) ON DELETE CASCADE,
  name                  TEXT,
  label                 VARCHAR(255),                  -- "Fit Food"
  thermo                VARCHAR(20),                   -- COLD / WARM / COLD_WARM
  kcal                  NUMERIC(7,2),
  protein_g             NUMERIC(7,2),
  fat_g                 NUMERIC(7,2),
  carbs_g               NUMERIC(7,2),
  fiber_g               NUMERIC(7,2),
  sugar_g               NUMERIC(7,2),
  saturated_fat_g       NUMERIC(7,2),
  salt_g                NUMERIC(7,2),
  image_url             TEXT,
  reviews_score         NUMERIC(5,2),
  reviews_number        INT,
  allergens             TEXT[],                        -- normalized dietlyAllergenName values
  ingredients           TEXT,                          -- raw concatenated; tough to normalize
  /** Hash of the volatile fields, used to detect dish-definition drift. */
  fingerprint           TEXT,
  first_seen_at         TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE meals_history (
  id                    BIGSERIAL PRIMARY KEY,
  captured_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  diet_calories_meal_id BIGINT NOT NULL,
  company_id            VARCHAR(255),
  name                  TEXT,
  kcal                  NUMERIC(7,2),
  protein_g             NUMERIC(7,2),
  fat_g                 NUMERIC(7,2),
  carbs_g               NUMERIC(7,2),
  reviews_score         NUMERIC(5,2),
  reviews_number        INT,
  fingerprint           TEXT,
  raw                   JSONB
);
CREATE INDEX idx_meals_hist_meal ON meals_history(diet_calories_meal_id, captured_at DESC);

-- "On capture C, for company X / kcal K / date D, slot S offered meal M"
-- Append-only. To get current state, GROUP BY (company, date, dc_id, slot)
-- and pick max(captured_at).
CREATE TABLE daily_menu (
  id                    BIGSERIAL PRIMARY KEY,
  captured_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  company_id            VARCHAR(255) NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  city_id               BIGINT NOT NULL REFERENCES cities(city_id),
  diet_calories_id      INT NOT NULL,
  tier_id               INT,
  menu_date             DATE NOT NULL,
  slot_name             VARCHAR(80),                   -- "Śniadanie", "Obiad", etc.
  diet_calories_meal_id BIGINT NOT NULL,
  is_default            BOOLEAN                         -- == baseDietCaloriesMealId
);
CREATE INDEX idx_daily_menu_lookup
  ON daily_menu(company_id, menu_date, diet_calories_id, captured_at DESC);
CREATE INDEX idx_daily_menu_meal_date ON daily_menu(diet_calories_meal_id, menu_date);
CREATE INDEX idx_daily_menu_captured  ON daily_menu(captured_at DESC);

-- ── views ─────────────────────────────────────────────────────────────────────

-- Latest snapshot of which meals are scheduled per day per company/kcal.
CREATE OR REPLACE VIEW current_daily_menu AS
SELECT DISTINCT ON (company_id, city_id, diet_calories_id, COALESCE(tier_id, -1), menu_date, slot_name, diet_calories_meal_id)
  *
FROM daily_menu
ORDER BY company_id, city_id, diet_calories_id, COALESCE(tier_id, -1),
         menu_date, slot_name, diet_calories_meal_id, captured_at DESC;

-- Currently-active promo codes (campaigns table is the SCD).
CREATE OR REPLACE VIEW active_promotions AS
SELECT *
FROM campaigns
WHERE COALESCE(deadline, CURRENT_DATE) >= CURRENT_DATE
  AND COALESCE(valid_to::date, CURRENT_DATE) >= CURRENT_DATE;
