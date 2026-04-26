-- dietlownik schema
-- Hierarchy: company → diet → tier → dietOption → dietCalories

CREATE TABLE IF NOT EXISTS cities (
  city_id          BIGINT PRIMARY KEY,
  name             VARCHAR(255) NOT NULL,
  sanitized_name   VARCHAR(255),
  county_name      VARCHAR(255),
  municipality_name VARCHAR(255),
  province_name    VARCHAR(255),
  city_status      BOOLEAN DEFAULT TRUE,
  number_of_companies INT,
  largest_city_for_name BOOLEAN DEFAULT FALSE,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS companies (
  company_id         VARCHAR(255) PRIMARY KEY,  -- URL slug, e.g. "robinfood"
  name               VARCHAR(255),
  logo_url           TEXT,
  avg_score          NUMERIC(5,2),
  feedback_value     NUMERIC(4,2),
  feedback_number    INT,
  awarded            BOOLEAN DEFAULT FALSE,
  price_category     VARCHAR(20),              -- CHEAP / MEDIUM / EXPENSIVE
  delivery_on_saturday BOOLEAN,
  delivery_on_sunday   BOOLEAN,
  menu_enabled       BOOLEAN,
  menu_days_ahead    INT,
  orders_enabled     BOOLEAN,
  delivery_enabled   BOOLEAN,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS company_cities (
  id                         SERIAL PRIMARY KEY,
  company_id                 VARCHAR(255) NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  city_id                    BIGINT NOT NULL REFERENCES cities(city_id) ON DELETE CASCADE,
  delivery_fee               NUMERIC(10,2),
  lowest_price_standard      NUMERIC(10,2),
  lowest_price_menu_config   NUMERIC(10,2),
  created_at                 TIMESTAMPTZ DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, city_id)
);

CREATE TABLE IF NOT EXISTS diet_tags (
  tag_code    VARCHAR(100) PRIMARY KEY,
  label       VARCHAR(255),
  description TEXT,
  image_url   TEXT
);

-- Diets belong to a company; diet_id is scoped per company
CREATE TABLE IF NOT EXISTS diets (
  id                    SERIAL PRIMARY KEY,
  diet_id               INT NOT NULL,
  company_id            VARCHAR(255) NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  name                  VARCHAR(255),
  description           TEXT,
  image_url             TEXT,
  awarded               BOOLEAN DEFAULT FALSE,
  avg_score             NUMERIC(5,2),
  feedback_value        NUMERIC(4,2),
  feedback_number       INT,
  diet_tag              VARCHAR(100) REFERENCES diet_tags(tag_code),
  is_menu_configuration BOOLEAN DEFAULT FALSE,
  diet_meal_count       INT,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (diet_id, company_id)
);

CREATE TABLE IF NOT EXISTS diet_discounts (
  id            SERIAL PRIMARY KEY,
  diet_id       INT NOT NULL,
  company_id    VARCHAR(255) NOT NULL,
  discount      NUMERIC(6,2) NOT NULL,
  minimum_days  INT NOT NULL,
  discount_type VARCHAR(50) NOT NULL,           -- PERCENTAGE / FIXED
  FOREIGN KEY (diet_id, company_id) REFERENCES diets(diet_id, company_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tiers (
  id                    SERIAL PRIMARY KEY,
  tier_id               INT NOT NULL,
  diet_id               INT NOT NULL,
  company_id            VARCHAR(255) NOT NULL,
  name                  VARCHAR(255),
  min_price             NUMERIC(10,2),
  meals_number          INT,
  default_option_change BOOLEAN DEFAULT FALSE,
  tag                   VARCHAR(100),           -- BESTSELLER / VEGE / null
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (tier_id, diet_id, company_id),
  FOREIGN KEY (diet_id, company_id) REFERENCES diets(diet_id, company_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS diet_options (
  id                  SERIAL PRIMARY KEY,
  diet_option_id      INT NOT NULL,
  tier_id             INT NOT NULL,
  diet_id             INT NOT NULL,
  company_id          VARCHAR(255) NOT NULL,
  tier_diet_option_id VARCHAR(50),              -- "{tierId}-{dietOptionId}"
  name                VARCHAR(255),
  diet_option_tag     VARCHAR(100),             -- STANDARD / VEGE / etc.
  is_default          BOOLEAN DEFAULT FALSE,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (diet_option_id, tier_id, diet_id, company_id),
  FOREIGN KEY (tier_id, diet_id, company_id) REFERENCES tiers(tier_id, diet_id, company_id) ON DELETE CASCADE
);

-- Leaf node; dietCaloriesId is globally unique in the API
CREATE TABLE IF NOT EXISTS diet_calories (
  diet_calories_id  INT PRIMARY KEY,
  diet_option_id    INT NOT NULL,
  tier_id           INT NOT NULL,
  diet_id           INT NOT NULL,
  company_id        VARCHAR(255) NOT NULL,
  calories          INT NOT NULL,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  FOREIGN KEY (diet_option_id, tier_id, diet_id, company_id)
    REFERENCES diet_options(diet_option_id, tier_id, diet_id, company_id) ON DELETE CASCADE
);

-- Prices from the calculate-price endpoint (truth oracle)
CREATE TABLE IF NOT EXISTS prices (
  id                           SERIAL PRIMARY KEY,
  diet_calories_id             INT NOT NULL REFERENCES diet_calories(diet_calories_id) ON DELETE CASCADE,
  company_id                   VARCHAR(255) NOT NULL REFERENCES companies(company_id),
  city_id                      BIGINT NOT NULL REFERENCES cities(city_id),
  tier_diet_option_id          VARCHAR(50),
  order_days                   INT NOT NULL,
  promo_codes                  TEXT[] DEFAULT '{}',
  per_day_cost                 NUMERIC(10,2),
  per_day_cost_with_discounts  NUMERIC(10,2),
  total_cost                   NUMERIC(10,2),
  total_cost_without_discounts NUMERIC(10,2),
  total_delivery_cost          NUMERIC(10,2),
  total_order_length_discount  NUMERIC(10,2),
  total_promo_code_discount    NUMERIC(10,2),
  total_delivery_discount      NUMERIC(10,2),
  captured_at                  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prices_diet_calories ON prices(diet_calories_id);
CREATE INDEX IF NOT EXISTS idx_prices_company_city  ON prices(company_id, city_id);

-- Site-wide promo campaigns (from /api/open/campaign-settings/active-campaign)
CREATE TABLE IF NOT EXISTS campaigns (
  id               SERIAL PRIMARY KEY,
  code             VARCHAR(100),
  title            VARCHAR(255),
  starts_at        DATE,
  ends_at          DATE,
  discount_percent NUMERIC(5,2),
  banner_image_url TEXT,
  is_active        BOOLEAN DEFAULT TRUE,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Daily menus (optional; requires /menu/ endpoint)
CREATE TABLE IF NOT EXISTS menus (
  id               SERIAL PRIMARY KEY,
  company_id       VARCHAR(255) NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  diet_calories_id INT NOT NULL REFERENCES diet_calories(diet_calories_id),
  city_id          BIGINT NOT NULL REFERENCES cities(city_id),
  tier_id          INT,
  menu_date        DATE NOT NULL,
  calories         INT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, diet_calories_id, city_id, menu_date)
);

CREATE TABLE IF NOT EXISTS meal_slots (
  id                        SERIAL PRIMARY KEY,
  menu_id                   INT NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
  name                      VARCHAR(255),         -- "Śniadanie", "Obiad", etc.
  base_diet_calories_meal_id INT
);

CREATE TABLE IF NOT EXISTS meal_options (
  id                     SERIAL PRIMARY KEY,
  meal_slot_id           INT NOT NULL REFERENCES meal_slots(id) ON DELETE CASCADE,
  diet_calories_meal_id  INT,
  name                   VARCHAR(500),
  label                  VARCHAR(255),            -- "Fit Food"
  info                   TEXT,                    -- raw "295 kcal • B:14g • …"
  calories_kcal          INT,
  protein_g              NUMERIC(6,1),
  fat_g                  NUMERIC(6,1),
  carbs_g                NUMERIC(6,1),
  thermo                 VARCHAR(20),             -- COLD / HOT
  reviews_number         INT,
  reviews_score          NUMERIC(5,2),
  allergens              TEXT,
  ingredients            TEXT,
  created_at             TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meal_options_slot ON meal_options(meal_slot_id);

