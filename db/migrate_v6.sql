-- v6: preserve more of the "whole image" across time.
--   1. diet_discounts: SCD (valid_from/valid_to) instead of DELETE+INSERT.
--   2. prices: omnibus + loyalty / pickup / side-orders / awarded points.
--   3. companies: missing scalar fields (deliveryInfo, dietlyDelivery,
--      awarded-and-top extras: invite_code_discount_percent, orderPossibleOn/To).
--   4. company_snapshots: capture every config flag, not just the 5 metrics.
--   5. diet_price_info_snapshots: per-diet advertised prices time-series (the
--      /city/{cityId} dietPriceInfo rows that were silently discarded).
--   6. company_city_snapshots: append-only history of advertised prices,
--      delivery fee, orders/delivery enabled, awarded-and-top extras.
--   7. reviews + review_snapshots: per-review canonical row + per-review drift
--      history, so the /feedback endpoint stops being a gap.
--   8. scrape_runs + scrape_errors: run-level observability so a silently-
--      failing company surfaces instead of vanishing into stderr.
--
-- Note: catalog scraper code also starts expiring missing tiers/options/leaves
-- (parallel to the existing diets pass). No schema change needed for that —
-- valid_from/valid_to columns already exist from v2.

-- ── 1. diet_discounts → SCD ──────────────────────────────────────────────────

ALTER TABLE diet_discounts
  ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS valid_to   TIMESTAMPTZ;

-- Treat any row pre-existing (rewritten by DELETE+INSERT in v5) as the current
-- live state for its (diet, company, days, type). Future scrapes diverge by
-- valid_to.
CREATE INDEX IF NOT EXISTS idx_diet_discounts_active
  ON diet_discounts (company_id, diet_id) WHERE valid_to IS NULL;

-- ── 2. prices: omnibus + loyalty / pickup / side-orders / awarded points ────

ALTER TABLE prices
  ADD COLUMN IF NOT EXISTS total_lowest_30days_cost_without_discounts NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS total_loyalty_points_discount              NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS total_pickup_point_discount                NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS total_one_time_side_orders_cost            NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS total_awarded_loyalty_program_points        INT,
  ADD COLUMN IF NOT EXISTS total_awarded_global_loyalty_program_points INT,
  ADD COLUMN IF NOT EXISTS total_promo_code_discount_info             TEXT;

-- ── 3. companies: missing scalar fields ─────────────────────────────────────

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS delivery_info_text          TEXT,
  ADD COLUMN IF NOT EXISTS delivery_info_date          DATE,
  ADD COLUMN IF NOT EXISTS dietly_delivery             BOOLEAN,
  ADD COLUMN IF NOT EXISTS recently_added              BOOLEAN,
  ADD COLUMN IF NOT EXISTS invite_code_discount_percent NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS order_possible_on           DATE,
  ADD COLUMN IF NOT EXISTS order_possible_to           TIMESTAMPTZ;

-- ── 4. company_snapshots: full config snapshot ──────────────────────────────

ALTER TABLE company_snapshots
  ADD COLUMN IF NOT EXISTS delivery_on_saturday        BOOLEAN,
  ADD COLUMN IF NOT EXISTS delivery_on_sunday          BOOLEAN,
  ADD COLUMN IF NOT EXISTS menu_enabled                BOOLEAN,
  ADD COLUMN IF NOT EXISTS menu_days_ahead             INT,
  ADD COLUMN IF NOT EXISTS orders_enabled              BOOLEAN,
  ADD COLUMN IF NOT EXISTS delivery_enabled            BOOLEAN,
  ADD COLUMN IF NOT EXISTS logo_url                    TEXT,
  ADD COLUMN IF NOT EXISTS delivery_info_text          TEXT,
  ADD COLUMN IF NOT EXISTS delivery_info_date          DATE,
  ADD COLUMN IF NOT EXISTS dietly_delivery             BOOLEAN,
  ADD COLUMN IF NOT EXISTS recently_added              BOOLEAN;

-- ── 5. diet_price_info_snapshots: per-diet advertised prices time-series ────
-- One row per (capture, company, city, diet). The /city/{cityId} dietPriceInfo
-- shape, including the `dietPriceInCompanyPromotion` flag.

CREATE TABLE IF NOT EXISTS diet_price_info_snapshots (
  id                              BIGSERIAL PRIMARY KEY,
  captured_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  company_id                      VARCHAR(255) NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  city_id                         BIGINT NOT NULL REFERENCES cities(city_id),
  diet_id                         INT NOT NULL,
  /** Parsed from "73.50 zł". Null when the API returned null. */
  discount_price                  NUMERIC(10,2),
  default_price                   NUMERIC(10,2),
  diet_price_in_company_promotion BOOLEAN,
  /** Raw kcal id list for forensics; the same diet may add/drop kcal tiers. */
  diet_calories_ids               INT[]
);
CREATE INDEX IF NOT EXISTS idx_dpi_snap_company_diet
  ON diet_price_info_snapshots (company_id, diet_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_dpi_snap_captured
  ON diet_price_info_snapshots (captured_at DESC);

-- ── 6. company_city_snapshots: time-series for the (company, city) tuple ────

CREATE TABLE IF NOT EXISTS company_city_snapshots (
  id                            BIGSERIAL PRIMARY KEY,
  captured_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  company_id                    VARCHAR(255) NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  city_id                       BIGINT NOT NULL REFERENCES cities(city_id),
  delivery_fee                  NUMERIC(10,2),
  lowest_price_standard         NUMERIC(10,2),
  lowest_price_menu_config      NUMERIC(10,2),
  orders_enabled                BOOLEAN,
  delivery_enabled              BOOLEAN,
  /** From awarded-and-top searchData[].inviteCodeDiscountPercent */
  invite_code_discount_percent  NUMERIC(5,2),
  /** From awarded-and-top searchData[].orderPossibleOn */
  order_possible_on             DATE,
  /** From awarded-and-top searchData[].orderPossibleTo (ISO). */
  order_possible_to             TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ccs_company_city
  ON company_city_snapshots (company_id, city_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_ccs_captured
  ON company_city_snapshots (captured_at DESC);

-- ── 7. reviews + review_snapshots ───────────────────────────────────────────
-- Identity = `feedbackId` from /feedback. Unknown if globally unique, so we
-- key on (company_id, feedback_id). Append a snapshot row when the
-- response_text changes (catering replies are mutable on dietly.pl).

CREATE TABLE IF NOT EXISTS reviews (
  id                       BIGSERIAL PRIMARY KEY,
  company_id               VARCHAR(255) NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  /** API returns composite strings like "robinfood_7305", not numeric ids. */
  feedback_id              VARCHAR(255) NOT NULL,
  /** YYYY-MM-DD; the day the review was posted. */
  review_date              DATE,
  /** Last delivery date the reviewer received before posting. */
  last_delivery_date       DATE,
  /** Per-review composite (avgScore in the dietly UI). */
  avg_score                NUMERIC(5,2),
  score_taste              NUMERIC(5,2),
  score_aesthetics         NUMERIC(5,2),
  score_ingredients_quality NUMERIC(5,2),
  score_packaging          NUMERIC(5,2),
  score_variety            NUMERIC(5,2),
  score_delivery           NUMERIC(5,2),
  order_duration           INT,
  verified                 BOOLEAN,
  text                     TEXT,
  response_text            TEXT,
  author                   VARCHAR(255),
  first_seen_at            TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (company_id, feedback_id)
);
CREATE INDEX IF NOT EXISTS idx_reviews_company_date
  ON reviews (company_id, review_date DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_seen
  ON reviews (last_seen_at DESC);

CREATE TABLE IF NOT EXISTS review_snapshots (
  id            BIGSERIAL PRIMARY KEY,
  review_id     BIGINT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  response_text TEXT,
  avg_score     NUMERIC(5,2),
  text          TEXT
);
CREATE INDEX IF NOT EXISTS idx_review_snap_review
  ON review_snapshots (review_id, captured_at DESC);

-- ── 8. scrape_runs + scrape_errors ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS scrape_runs (
  id            BIGSERIAL PRIMARY KEY,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ,
  /** Free-form label: "scrape", "scrape:promo-prices", "menus", etc. */
  cmd           VARCHAR(80) NOT NULL,
  /** Free-form scope label: city + company filter, etc. */
  scope         VARCHAR(255),
  /** Companies processed OK / total companies attempted. */
  ok_count      INT,
  fail_count    INT,
  /** Set on fatal exit. */
  fatal_error   TEXT
);
CREATE INDEX IF NOT EXISTS idx_scrape_runs_started
  ON scrape_runs (started_at DESC);

CREATE TABLE IF NOT EXISTS scrape_errors (
  id           BIGSERIAL PRIMARY KEY,
  run_id       BIGINT REFERENCES scrape_runs(id) ON DELETE CASCADE,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  /** Pipeline stage: catalog | prices | menus | promotions | reviews | … */
  stage        VARCHAR(40) NOT NULL,
  company_id   VARCHAR(255),
  /** API path or DB query that failed. */
  context      TEXT,
  status_code  INT,
  message      TEXT
);
CREATE INDEX IF NOT EXISTS idx_scrape_errors_run
  ON scrape_errors (run_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_scrape_errors_company_stage
  ON scrape_errors (company_id, stage, occurred_at DESC);
