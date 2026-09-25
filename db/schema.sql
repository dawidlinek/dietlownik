-- ── Extensions ────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── Geography & companies (no history) ───────────────────────────────────
-- city_id is dietly's cityId = the GUS TERYT SIMC code of the locality.
-- Names repeat (seven Józefów in Mazowieckie), hence county/municipality.
-- tracked: the scraper keeps this city's catering list, delivery terms and
-- advertised prices fresh (scraper/scrapers/city-refresh.ts).
CREATE TABLE cities (
  city_id BIGINT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  sanitized_name VARCHAR(255),
  province_name VARCHAR(255),
  county_name VARCHAR(255),
  municipality_name VARCHAR(255),
  largest_city_for_name BOOLEAN,
  number_of_companies INT,
  tracked BOOLEAN NOT NULL DEFAULT FALSE,
  last_refreshed_at TIMESTAMPTZ,
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
  -- Dietly's per-catering "is the nutrition / ingredient panel displayable"
  -- switches (constant.formSettings.visibleNutritionInDietly and
  -- visibleIngredientsInDietly). When false, the menu API still returns a
  -- body but dietly's own UI hides it — and the body is often a uniform
  -- placeholder repeated across every option (the "leczo bug" on urbanfits,
  -- the kakao bug on przelomwodzywianiu, etc.). The menus scraper honors
  -- these flags and writes null body fields when either is off.
  nutrition_visible BOOLEAN NOT NULL DEFAULT TRUE,
  ingredients_visible BOOLEAN NOT NULL DEFAULT TRUE,
  -- /constant contactDetails; address is dietly's JSON (street, zip, city…)
  -- of the kitchen / company seat.
  description TEXT,
  email TEXT,
  phone TEXT,
  address JSONB,
  delivery_cities_count INT,          -- /constant deliveryCities.numberOfCities
  -- Capability flags (selfPickup, mealSwitchingEnabled, testOrdersPossible,
  -- loyaltyProgramEnabled, …): /constant companyParams merged with the
  -- awarded-and-top params when the run has them.
  params JSONB,
  positive_meals_review_percent INT,  -- awarded-and-top
  -- The tracked city the national pass scrapes this catering from (catalog,
  -- menus, prices): the anchor city when it delivers there, else the lowest
  -- tracked city id it delivers to. Sticky while it stays valid.
  home_city_id BIGINT REFERENCES cities,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Which caterings deliver to a city, with that city's terms. Membership has
-- a lifecycle: a city refresh that no longer lists a catering flips
-- is_active off (and closes its per-city spans) rather than deleting.
-- price_city_id: the city whose price_history quotes apply here — the
-- catering's home city when this city advertises the same diet prices (or
-- none at all: some caterings never publish them), otherwise one
-- representative city per distinct advertised price list.
-- Read prices for a city through city_quotes(), never price_history directly.
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
  -- [{id, from, to}] sorted by id; dietly's delivery windows for this city.
  delivery_times JSONB,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  price_city_id BIGINT REFERENCES cities,
  PRIMARY KEY (company_id, city_id)
);
CREATE INDEX company_cities_active_city
  ON company_cities (city_id, company_id) WHERE is_active;

-- Per-city catering terms over time (spans; see "History model"). The
-- company_cities row holds the current values; this is the timeline of the
-- advertised delivery fee, the "from" prices and whether ordering/delivery is
-- switched on. The fee actually charged on a quote is price_history's
-- total_delivery_cost (already included in total_cost).
-- order_possible_on/to are left out: they roll forward every day by design.
CREATE TABLE company_city_history (
  id BIGSERIAL PRIMARY KEY,
  company_id VARCHAR(255) NOT NULL REFERENCES companies ON DELETE CASCADE,
  city_id BIGINT NOT NULL REFERENCES cities ON DELETE CASCADE,
  delivery_fee NUMERIC(10,2),
  lowest_price_standard NUMERIC(10,2),
  lowest_price_menu_config NUMERIC(10,2),
  orders_enabled BOOLEAN,
  delivery_enabled BOOLEAN,
  delivery_times JSONB,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  observations  INT NOT NULL DEFAULT 1 CHECK (observations > 0),
  closed_at     TIMESTAMPTZ,
  CHECK (last_seen_at >= first_seen_at),
  CHECK (closed_at IS NULL OR closed_at >= last_seen_at)
);
CREATE UNIQUE INDEX company_city_history_open_key
  ON company_city_history (company_id, city_id)
  WHERE closed_at IS NULL;
CREATE INDEX company_city_history_series
  ON company_city_history (company_id, city_id, first_seen_at);

-- Advertised per-diet prices for a city (/city dietPriceInfo) over time: the
-- list price, the promo price and whether a company promotion applies. The
-- price actually paid is price_history.
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

-- Paid extras a catering sells alongside diets (/constant companySideOrders).
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

-- Catering settings over time (spans; see "History model"). companies holds
-- the current row; ratings have their own timeline (company_ratings_history).
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
  description TEXT,
  email TEXT,
  phone TEXT,
  address JSONB,
  delivery_cities_count INT,
  params JSONB,
  positive_meals_review_percent INT,
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

-- ── Diet hierarchy (drift-tracked) ───────────────────────────────────────
-- Pattern: canonical row mutable; companion *_snapshots append on fingerprint change.
-- All catalog tables carry: fingerprint, first_seen_at, last_seen_at, is_active.
-- is_active flips false when a scrape doesn't see the entity; flipped back on reappearance.

CREATE TABLE diet_tags (
  tag_code VARCHAR(100) PRIMARY KEY,
  label VARCHAR(255),
  description TEXT,          -- dietDescriptions, "title\n\ndescription" blocks
  similar_tags TEXT[]        -- dietTagSimilarDiets
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
-- Per-diet rating timeline (e.g. KETO at Twoje Menu over time) is captured
-- here as a side effect: the fingerprint includes avg_score / feedback_value
-- / feedback_number, so any rating change triggers a new snapshot row.
-- Query with WHERE diet_tag = 'KETO' AND company_id = 'twojemenu' to plot.
CREATE INDEX ON diet_snapshots (company_id, diet_id, captured_at DESC);

-- ── Company-level rating history ─────────────────────────────────────────
-- The `companies` row holds the current aggregate; this table is the
-- timeline. Only inserted when (avg_score, feedback_value, feedback_number)
-- actually changed vs the most recent row — so the table grows roughly with
-- review velocity, not scrape frequency. Per-diet ratings live in
-- diet_snapshots above (see comment).
CREATE TABLE company_ratings_history (
  id BIGSERIAL PRIMARY KEY,
  company_id VARCHAR(255) NOT NULL REFERENCES companies ON DELETE CASCADE,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  avg_score NUMERIC(5,2),
  feedback_value NUMERIC(4,2),
  feedback_number INT
);
CREATE INDEX ON company_ratings_history (company_id, captured_at DESC);

CREATE TABLE tiers (
  company_id VARCHAR(255) NOT NULL,
  diet_id INT NOT NULL,
  tier_id INT NOT NULL,
  name VARCHAR(255),
  meals_number INT,
  tag VARCHAR(100),
  description TEXT,          -- what the package includes
  min_price NUMERIC(10,2),   -- advertised "from" price per day
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
  description TEXT, min_price NUMERIC(10,2),
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

-- `diet_calories_id` is dietly's per-catering id (scraped from their mobile
-- API), so it's NOT globally unique — multiple caterings happily reuse 1, 2,
-- 3, … as their own internal ids. Old layouts that used it as a global
-- SERIAL silently dropped every collision and lost ~70/150 catalogs.
--
-- It is not unique within a catering either: menu-configuration diets reuse
-- one id across their tiers (meal-count packages at different prices) —
-- 1,833 ids at 64 of 165 caterings on 2026-09-23, always same diet and
-- option, never twice in one tier. A leaf is therefore
-- (company_id, diet_calories_id, tier_id); keying without the tier kept one
-- package per id and silently dropped the rest (fixed in v13).
CREATE TABLE diet_calories (
  diet_calories_id INT NOT NULL,
  company_id VARCHAR(255) NOT NULL,
  diet_id INT NOT NULL,
  tier_id INT NOT NULL,
  diet_option_id INT NOT NULL,
  calories INT,              -- NULL when only /city listed the id
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ DEFAULT NOW(),
  is_active     BOOLEAN DEFAULT TRUE,
  PRIMARY KEY (company_id, diet_calories_id, tier_id),
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
  -- 0 = the diet's own ladder; otherwise a tier's ladder (dietTiers[].discounts)
  tier_id INT NOT NULL DEFAULT 0,
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ DEFAULT NOW(),
  is_active     BOOLEAN DEFAULT TRUE,
  FOREIGN KEY (company_id, diet_id) REFERENCES diets ON DELETE CASCADE,
  CONSTRAINT diet_discounts_ladder_key
    UNIQUE (company_id, diet_id, tier_id, minimum_days, discount_type)
);

-- Full discount table snapshot per (company, diet) drift; one row per drift.
CREATE TABLE diet_discount_snapshots (
  id BIGSERIAL PRIMARY KEY,
  company_id VARCHAR(255) NOT NULL, diet_id INT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fingerprint TEXT NOT NULL,
  discounts JSONB NOT NULL                    -- [{discount, minimum_days, discount_type[, tier_id]}, ...]
);
CREATE INDEX ON diet_discount_snapshots (company_id, diet_id, captured_at DESC);

-- ── History model: spans, not event logs ─────────────────────────────────
-- Observed facts that repeat on every scrape (a price quote, a dish on a
-- menu) are stored as SPANS: one row per unbroken run of identical
-- observations, instead of one row per scrape.
--
--   first_seen_at  first observation of this exact value
--   last_seen_at   latest observation of this exact value
--   observations   how many scrapes saw it (sum = old event-log row count)
--   closed_at      NULL while the span is current; otherwise the moment we
--                  observed it was no longer true — the value changed, the
--                  item was missing from a successful fetch of its scope, or
--                  it reappeared after a gap. The real end lies somewhere in
--                  (last_seen_at, closed_at].
--
-- A span is extended only when the new observation carries identical values
-- AND lands within SPAN_GAP (36 h) of last_seen_at. A longer silence starts a
-- new span, so a span never claims we saw something during a scraper outage.
-- At most one open span per key is enforced by a partial unique index.
--
-- Current state is simply `closed_at IS NULL` (see the current_* views).
-- History queries read the full table.

-- ── Scrape log ────────────────────────────────────────────────────────────
-- What ran, when, and what failed. Needed to tell "the catering removed it"
-- apart from "we didn't manage to scrape that catering that day".
CREATE TABLE scrape_runs (
  run_id BIGSERIAL PRIMARY KEY,
  cmd TEXT NOT NULL,
  scope TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'ok', 'partial', 'failed')),
  ok_count INT,
  fail_count INT,
  -- Priced dishes (dish × day × kcal leaf × city) across all history, computed after the run
  -- finishes (scraper/selection-size.ts). The dashboard footer shows the
  -- latest non-NULL value.
  selection_size BIGINT
);
CREATE INDEX ON scrape_runs (started_at DESC);

-- One row per (run, company, stage) that was attempted. ok = the stage
-- finished without throwing; per-request failures inside it land in
-- scrape_errors and are summarised in fail_count.
CREATE TABLE scrape_stage_results (
  run_id BIGINT NOT NULL REFERENCES scrape_runs ON DELETE CASCADE,
  company_id VARCHAR(255) NOT NULL,
  stage TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ok BOOLEAN NOT NULL,
  fail_count INT NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, company_id, stage)
);
CREATE INDEX ON scrape_stage_results (company_id, stage, finished_at DESC);

CREATE TABLE scrape_errors (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT REFERENCES scrape_runs ON DELETE CASCADE,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stage TEXT NOT NULL,
  company_id VARCHAR(255),
  context TEXT,
  status_code INT,
  message TEXT
);
CREATE INDEX ON scrape_errors (run_id);
CREATE INDEX ON scrape_errors (company_id, captured_at DESC);

-- ── Prices (spans) ────────────────────────────────────────────────────────
-- One span per unbroken run of an identical quote for
-- (catering, diet variant, city, order length, promo set).
--
-- Effective net per-day at read time is total_cost / order_days — dietly's
-- API returns promo discounts as a separate `totalPromoCodeDiscount` line,
-- so storing a precomputed "with discounts" per-day was misleading and we
-- don't.
CREATE TABLE price_history (
  id BIGSERIAL PRIMARY KEY,
  diet_calories_id INT NOT NULL,
  tier_id INT NOT NULL,
  company_id VARCHAR(255) NOT NULL,
  city_id BIGINT NOT NULL REFERENCES cities,
  order_days INT NOT NULL,
  promo_codes TEXT[] NOT NULL DEFAULT '{}',
  -- List per-day (no discounts).
  per_day_cost                NUMERIC(10,2),
  -- Totals
  total_cost                  NUMERIC(10,2),  -- = totalCostToPay, NET of all discounts
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
  total_awarded_global_loyalty_program_points INT,
  -- Span bookkeeping (see "History model" above)
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  observations  INT NOT NULL DEFAULT 1 CHECK (observations > 0),
  closed_at     TIMESTAMPTZ,
  CHECK (last_seen_at >= first_seen_at),
  CHECK (closed_at IS NULL OR closed_at >= last_seen_at),
  FOREIGN KEY (company_id, diet_calories_id, tier_id)
    REFERENCES diet_calories ON DELETE CASCADE
);
CREATE UNIQUE INDEX price_history_open_key
  ON price_history (company_id, diet_calories_id, tier_id, city_id, order_days, promo_codes)
  WHERE closed_at IS NULL;
-- Ranking hot path: every current quote for a city.
CREATE INDEX price_history_open_city
  ON price_history (city_id, company_id, diet_calories_id, tier_id)
  WHERE closed_at IS NULL;
-- Price-history chart / time-series analysis.
CREATE INDEX price_history_series
  ON price_history (company_id, diet_calories_id, tier_id, city_id, first_seen_at);

CREATE VIEW current_prices AS
SELECT * FROM price_history WHERE closed_at IS NULL;

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

-- ── Campaigns (mutable; no history) ───────────────────────────────────────
-- NULLS NOT DISTINCT: global campaigns carry company_id = NULL, and a plain
-- UNIQUE treats every NULL as distinct, so each scrape inserted a new copy.
CREATE TABLE campaigns (
  id BIGSERIAL PRIMARY KEY,
  company_id VARCHAR(255) REFERENCES companies,
  code VARCHAR(100),
  title VARCHAR(255),
  discount_percent NUMERIC(5,2),
  starts_at DATE,
  ends_at DATE,
  -- Exact validity when a source gives it (awarded-and-top activePromotion);
  -- starts_at / ends_at are the Warsaw dates.
  valid_from TIMESTAMPTZ,
  valid_to TIMESTAMPTZ,
  -- TRUE: the code must be typed at checkout; advertised prices exclude it.
  separate BOOLEAN,
  is_active BOOLEAN DEFAULT TRUE,
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE NULLS NOT DISTINCT (company_id, code)
);

-- Promo-code terms over time (spans; see "History model"). campaigns holds
-- the current row; the scraper records it here after every upsert and every
-- expiry sweep. company_id NULL = a global code.
CREATE TABLE campaign_history (
  id BIGSERIAL PRIMARY KEY,
  company_id VARCHAR(255) REFERENCES companies ON DELETE CASCADE,
  code VARCHAR(100),
  title VARCHAR(255),
  discount_percent NUMERIC(5,2),
  starts_at DATE,
  ends_at DATE,
  valid_from TIMESTAMPTZ,
  valid_to TIMESTAMPTZ,
  separate BOOLEAN,
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

-- ── Meals: identity, content variants, per-variant ingredients ───────────
-- A dish is (company_id, name). What a dish *contains* is not a property of
-- the dish: the same name is served at the same time in several diets, with
-- different ingredient lists (and different portions — those live on
-- menu_items). Storing one content per dish made every scrape overwrite it
-- back and forth, so content is split out:
--
--   meals           identity only
--   meal_variants   content-addressed: one row per distinct content ever
--                   seen, keyed by meal_content_sha(). Immutable; a return
--                   to an earlier content reuses its row.
--   meal_ingredients  structured ingredient list of one variant (a view over
--                   variant_ingredients + ingredient_names)
--
-- menu_items points at the exact variant that was served.
CREATE TABLE meals (
  id BIGSERIAL PRIMARY KEY,
  company_id VARCHAR(255) NOT NULL REFERENCES companies ON DELETE CASCADE,
  name TEXT NOT NULL,
  image_url TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- lowercase + Polish-diacritic-folded copy of `name`; matches the alphabet
  -- emitted by lib/preference-router.ts's normalize(). Enables trigram fuzzy
  -- match against meal names from the ingredient/preference channel.
  name_normalized TEXT GENERATED ALWAYS AS (
    LOWER(TRANSLATE(name,
      'ąćęłńóśźżĄĆĘŁŃÓŚŹŻ',
      'acelnoszzACELNOSZZ'))
  ) STORED,
  UNIQUE (company_id, name)
);
-- gin_trgm_ops serves both `%` and the word-similarity `<%` operator.
CREATE INDEX ON meals USING gin (name_normalized gin_trgm_ops);

-- Canonical content hash. Computed in the database so the scraper and the
-- v11 backfill hash identically. Ingredient order and spelling are part of
-- the content (they are data), so this is exact, not normalised.
CREATE FUNCTION meal_content_sha(
  p_label TEXT, p_thermo TEXT, p_allergens TEXT[], p_ingredients JSONB
) RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT encode(sha256(convert_to(jsonb_build_array(
    COALESCE(p_label, ''),
    COALESCE(p_thermo, ''),
    (SELECT COALESCE(jsonb_agg(a ORDER BY a COLLATE "C"), '[]'::jsonb)
       FROM unnest(COALESCE(p_allergens, '{}'::text[])) AS a),
    (SELECT COALESCE(jsonb_agg(
              jsonb_build_array(e->>'name_raw', COALESCE((e->>'is_major')::boolean, FALSE))
              ORDER BY (e->>'position')::int), '[]'::jsonb)
       FROM jsonb_array_elements(COALESCE(p_ingredients, '[]'::jsonb)) AS e)
  )::text, 'UTF8')), 'hex')
$$;

CREATE TABLE meal_variants (
  id BIGSERIAL PRIMARY KEY,
  meal_id BIGINT NOT NULL REFERENCES meals ON DELETE CASCADE,
  content_sha TEXT NOT NULL,
  label VARCHAR(255),
  thermo VARCHAR(20),
  allergens TEXT[] NOT NULL DEFAULT '{}',   -- normalized dietlyAllergenName, sorted
  ingredients_raw TEXT,                     -- verbatim "; "-joined list (embedding source)
  -- [{id, company_name, dietly_name}] as served (dietaryExclusionId and the
  -- catering's own wording, e.g. "JĘCZMIEŃ (GLUTEN)"). Not part of the hash.
  allergens_detail JSONB,
  -- 'scrape' = observed as stored. 'v11-backfill' = rebuilt from the pre-v11
  -- ingredient snapshots, which never recorded label/thermo/allergens per
  -- version: those three were copied from the dish's last-known values.
  origin TEXT NOT NULL DEFAULT 'scrape' CHECK (origin IN ('scrape', 'v11-backfill')),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (meal_id, content_sha)
);

-- Ingredient names are a small vocabulary (14k names across 4.7M rows), so
-- each is stored once and trigram-indexed once.
CREATE TABLE ingredient_names (
  id SERIAL PRIMARY KEY,
  name_raw TEXT NOT NULL UNIQUE,
  name_normalized TEXT NOT NULL      -- lowercase, Polish-folded, see menus.ts
);
CREATE INDEX ON ingredient_names USING gin (name_normalized gin_trgm_ops);

-- dietly's own ingredient / allergen vocabulary (dietaryExclusionId), the ids
-- its "wyklucz" filters use: 639 ziemniaki, 203 indyk, 1 gluten, …
CREATE TABLE dietary_exclusions (
  exclusion_id INT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE variant_ingredients (
  variant_id BIGINT NOT NULL REFERENCES meal_variants ON DELETE CASCADE,
  position INT NOT NULL,
  name_id INT NOT NULL REFERENCES ingredient_names,
  is_major BOOLEAN NOT NULL DEFAULT FALSE,
  exclusion_ids INT[],       -- dietary_exclusions this ingredient maps to
  PRIMARY KEY (variant_id, position)
);
CREATE INDEX ON variant_ingredients (name_id);

-- The per-variant list with names inlined. Read through this; write through
-- ingredient_names + variant_ingredients (scraper/scrapers/menus.ts).
CREATE VIEW meal_ingredients AS
SELECT vi.variant_id, vi.position, n.name_raw, n.name_normalized, vi.is_major
FROM variant_ingredients vi
JOIN ingredient_names n ON n.id = vi.name_id;

-- Most recently seen variant per dish — for scripts and ad-hoc queries that
-- want "the dish as it looks now". Ranking never uses this: it reads the
-- variant each menu item actually served.
CREATE VIEW meal_latest_variant AS
SELECT DISTINCT ON (v.meal_id)
  v.meal_id, v.id AS variant_id, v.label, v.thermo, v.allergens,
  v.ingredients_raw, v.origin, v.first_seen_at, v.last_seen_at
FROM meal_variants v
ORDER BY v.meal_id, v.last_seen_at DESC, v.id DESC;

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

-- ── Menu (spans) ──────────────────────────────────────────────────────────
-- One span per unbroken run of one menu option looking the same.
--
-- Menus are national: no city_id (v15). check:cities found 0 of 435
-- (catering, city) pairs with a different menu, so a menu belongs to the
-- catering; which caterings a city can order from is company_cities.
--
-- Key: an option is (company, diet_calories_id, tier, date,
-- api_meal_slot_id). dietly's dietCaloriesMealId is unique within a menu
-- response and stable across scrapes of the same date — the slot name and
-- default flag never change for it, the dish does in ~2% of cases (a real
-- menu swap, which closes the span and opens a new one).
--
-- Portion-dependent numbers live here, not on the dish: the same dish is
-- served at different kcal in different diets. The menus scraper fetches
-- the lowest-kcal sibling of each (tier, option) family, so these are that
-- portion's numbers; the ranking scales them to other siblings.
CREATE TABLE menu_items (
  id BIGSERIAL PRIMARY KEY,
  company_id VARCHAR(255) NOT NULL,
  diet_calories_id INT NOT NULL,
  tier_id INT NOT NULL,
  menu_date DATE NOT NULL,
  api_meal_slot_id BIGINT NOT NULL,
  slot_name VARCHAR(80) NOT NULL,
  meal_id BIGINT NOT NULL REFERENCES meals ON DELETE CASCADE,
  variant_id BIGINT REFERENCES meal_variants ON DELETE SET NULL,
  is_default BOOLEAN NOT NULL,
  kcal NUMERIC(7,2),
  protein_g NUMERIC(7,2),
  fat_g NUMERIC(7,2),
  carbs_g NUMERIC(7,2),
  fiber_g NUMERIC(7,2),
  sugar_g NUMERIC(7,2),
  saturated_fat_g NUMERIC(7,2),
  salt_g NUMERIC(7,2),
  reviews_score NUMERIC(5,2),
  reviews_number INT,
  image_url TEXT,                   -- the dish photo this option showed
  -- Span bookkeeping (see "History model" above)
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  observations  INT NOT NULL DEFAULT 1 CHECK (observations > 0),
  closed_at     TIMESTAMPTZ,
  CHECK (last_seen_at >= first_seen_at),
  CHECK (closed_at IS NULL OR closed_at >= last_seen_at),
  FOREIGN KEY (company_id, diet_calories_id, tier_id)
    REFERENCES diet_calories ON DELETE CASCADE
);
-- Writer: all open options of one fetched menu. Also enforces one open span
-- per option.
CREATE UNIQUE INDEX menu_items_open_key
  ON menu_items (company_id, diet_calories_id, tier_id, menu_date, api_meal_slot_id)
  WHERE closed_at IS NULL;
-- Ranking hot path: every current option for a day (the city filter is a
-- company_cities join).
CREATE INDEX menu_items_open_date
  ON menu_items (menu_date, company_id, diet_calories_id)
  WHERE closed_at IS NULL;
-- History: how one diet's menu for a date evolved.
CREATE INDEX menu_items_history
  ON menu_items (company_id, diet_calories_id, menu_date, first_seen_at);
CREATE INDEX ON menu_items (meal_id);
CREATE INDEX ON menu_items (variant_id);

CREATE VIEW current_menu_items AS
SELECT * FROM menu_items WHERE closed_at IS NULL;

-- ── Vectors (e5-small; one per variant) ──────────────────────────────────
-- 384 dims matches Xenova/multilingual-e5-small. If the production model
-- changes, update this AND the τ/divisor constants in lib/queries.ts. See
-- EMBEDDINGS.md for the calibration story.
--
-- Variants are immutable, so each has exactly one embedding. passage_version
-- is the version of buildPassage() (scraper/meal-passage.ts) that produced
-- it; bumping that constant makes `embed` redo every older vector.
--
-- No ANN (HNSW) index: ranking computes exact cosine over one day's
-- candidates, which never used it.
CREATE TABLE variant_embeddings (
  variant_id BIGINT PRIMARY KEY REFERENCES meal_variants ON DELETE CASCADE,
  passage_version SMALLINT NOT NULL,
  embedding vector(384) NOT NULL,
  embedded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Keyword embedding cache (ephemeral) ───────────────────────────────────
CREATE TABLE keyword_embeddings (
  keyword TEXT PRIMARY KEY,
  embedding vector(384) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ON keyword_embeddings (last_used_at DESC);
