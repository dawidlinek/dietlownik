-- v2: temporal tracking for prices, catalog, promos, and company metrics

-- ── Catalog tables: track when each item first appeared and when it was removed ──

ALTER TABLE diets
  ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS valid_to   TIMESTAMPTZ;           -- NULL = still active

ALTER TABLE tiers
  ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS valid_to   TIMESTAMPTZ;

ALTER TABLE diet_options
  ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS valid_to   TIMESTAMPTZ;

ALTER TABLE diet_calories
  ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS valid_to   TIMESTAMPTZ;

-- Fast lookup: "which kcal nodes are currently live?"
CREATE INDEX IF NOT EXISTS idx_diet_calories_active ON diet_calories(valid_to) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_diet_options_active  ON diet_options(valid_to)  WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_tiers_active         ON tiers(valid_to)         WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_diets_active         ON diets(valid_to)         WHERE valid_to IS NULL;

-- ── Prices: already append-only; add indexes for time-series queries ──

-- "how did the 10-day price for diet X change over the last month?"
CREATE INDEX IF NOT EXISTS idx_prices_ts ON prices(company_id, city_id, diet_calories_id, order_days, captured_at);
CREATE INDEX IF NOT EXISTS idx_prices_captured_at ON prices(captured_at DESC);

-- ── Campaigns / promo codes: one row per observed state ──
-- starts_at/ends_at = promo validity dates from the API
-- first_seen_at     = when our scraper first saw this code active
-- last_seen_at      = updated each scrape run while code is still live
--   → gap between last_seen_at and now means the promo was silently removed

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS last_seen_at  TIMESTAMPTZ DEFAULT NOW();

-- unique active campaign per code so we can upsert on conflict
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaigns_code_active
  ON campaigns(code) WHERE is_active = TRUE;

-- ── Company snapshots: periodic metric capture (score, price category, etc.) ──
-- Lets us detect rating drift, category changes, coverage changes over time.

CREATE TABLE IF NOT EXISTS company_snapshots (
  id              SERIAL PRIMARY KEY,
  company_id      VARCHAR(255) NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  avg_score       NUMERIC(5,2),
  feedback_value  NUMERIC(4,2),
  feedback_number INT,
  awarded         BOOLEAN,
  price_category  VARCHAR(20),           -- CHEAP / MEDIUM / EXPENSIVE
  captured_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_company_snapshots_ts
  ON company_snapshots(company_id, captured_at DESC);

-- ── Useful views ──

-- Latest price per (company, city, diet_calories, order_days, promo combo)
CREATE OR REPLACE VIEW latest_prices AS
SELECT DISTINCT ON (company_id, city_id, diet_calories_id, order_days, promo_codes)
  *
FROM prices
ORDER BY company_id, city_id, diet_calories_id, order_days, promo_codes, captured_at DESC;

-- Price change events: rows where per_day_cost_with_discounts changed vs previous capture
CREATE OR REPLACE VIEW price_changes AS
SELECT
  p.*,
  prev.per_day_cost_with_discounts AS prev_per_day,
  p.per_day_cost_with_discounts - prev.per_day_cost_with_discounts AS delta
FROM prices p
JOIN LATERAL (
  SELECT per_day_cost_with_discounts
  FROM prices p2
  WHERE p2.company_id      = p.company_id
    AND p2.city_id          = p.city_id
    AND p2.diet_calories_id = p.diet_calories_id
    AND p2.order_days       = p.order_days
    AND p2.promo_codes      = p.promo_codes
    AND p2.captured_at      < p.captured_at
  ORDER BY p2.captured_at DESC
  LIMIT 1
) prev ON TRUE
WHERE p.per_day_cost_with_discounts IS DISTINCT FROM prev.per_day_cost_with_discounts;

-- Currently active promo campaigns
CREATE OR REPLACE VIEW active_campaigns AS
SELECT *
FROM campaigns
WHERE is_active = TRUE
  AND (ends_at IS NULL OR ends_at >= CURRENT_DATE);
