-- v5: re-key meals by (company_id, name).
--
-- The mobile API's `dietCaloriesMealId` is a *per-day slot index*, NOT a stable
-- dish identifier. Verified live: id 331 maps to a different dish each day.
-- Real stable identity in this dataset is (companyId, dishName).
--
-- This migration drops the v4 meals/meals_history (we have no production data
-- worth preserving — every row is from today's smoke runs) and rebuilds them
-- around the dish-name identity. daily_menu also gets a meal_id FK so we can
-- link day×slot rows back to the canonical dish definition.

DROP TABLE IF EXISTS meals_history CASCADE;
DROP TABLE IF EXISTS meals        CASCADE;

CREATE TABLE meals (
  id              BIGSERIAL PRIMARY KEY,
  company_id      VARCHAR(255) NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  /** dish identity within a company. */
  name            TEXT NOT NULL,
  label           VARCHAR(255),                  -- diet variant (e.g. "Fit Food")
  thermo          VARCHAR(20),
  kcal            NUMERIC(7,2),
  protein_g       NUMERIC(7,2),
  fat_g           NUMERIC(7,2),
  carbs_g         NUMERIC(7,2),
  fiber_g         NUMERIC(7,2),
  sugar_g         NUMERIC(7,2),
  saturated_fat_g NUMERIC(7,2),
  salt_g          NUMERIC(7,2),
  image_url       TEXT,
  reviews_score   NUMERIC(5,2),
  reviews_number  INT,
  allergens       TEXT[],
  ingredients     TEXT,
  /** Hash of macros + name; changes when the dish definition drifts. */
  fingerprint     TEXT,
  first_seen_at   TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, name)
);

CREATE INDEX idx_meals_name_trgm ON meals (company_id, lower(name));

CREATE TABLE meals_history (
  id              BIGSERIAL PRIMARY KEY,
  meal_id         BIGINT NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
  captured_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  name            TEXT,
  kcal            NUMERIC(7,2),
  protein_g       NUMERIC(7,2),
  fat_g           NUMERIC(7,2),
  carbs_g         NUMERIC(7,2),
  reviews_score   NUMERIC(5,2),
  reviews_number  INT,
  fingerprint     TEXT
);
CREATE INDEX idx_meals_hist_meal ON meals_history (meal_id, captured_at DESC);

-- ── daily_menu: link to canonical meal + retain raw API id for forensics ──────

DROP TABLE IF EXISTS daily_menu CASCADE;

CREATE TABLE daily_menu (
  id                          BIGSERIAL PRIMARY KEY,
  captured_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  company_id                  VARCHAR(255) NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  city_id                     BIGINT NOT NULL REFERENCES cities(city_id),
  diet_calories_id            INT NOT NULL,
  tier_id                     INT,
  menu_date                   DATE NOT NULL,
  slot_name                   VARCHAR(80),                  -- "Śniadanie", "Obiad", etc.
  meal_id                     BIGINT REFERENCES meals(id) ON DELETE SET NULL,
  /** Raw per-day per-call slot id from the API (NOT a stable dish id). */
  api_meal_slot_id            BIGINT,
  /** True iff API said baseDietCaloriesMealId == this option's id. */
  is_default                  BOOLEAN
);
CREATE INDEX idx_daily_menu_lookup
  ON daily_menu (company_id, menu_date, diet_calories_id, captured_at DESC);
CREATE INDEX idx_daily_menu_meal_date
  ON daily_menu (meal_id, menu_date);
CREATE INDEX idx_daily_menu_captured ON daily_menu (captured_at DESC);

-- ── view: latest snapshot per (company, kcal, date, slot, meal) ──────────────

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
