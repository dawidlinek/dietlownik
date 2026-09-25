-- v12: history for per-city catering terms (delivery fee, "from" prices,
-- ordering switches). Additive and idempotent-safe: creates one table.
-- Existing company_cities values are not seeded as history — we don't know
-- since when they held; the next scrape opens the first spans.

-- Per-city catering terms over time (spans; see "History model"). The
-- company_cities row holds the current values; this is the timeline of the
-- advertised delivery fee, the "from" prices and whether ordering/delivery is
-- switched on. The fee actually charged on a quote is price_history's
-- total_delivery_cost (already included in total_cost).
-- order_possible_on/to are left out: they roll forward every day by design.
CREATE TABLE IF NOT EXISTS company_city_history (
  id BIGSERIAL PRIMARY KEY,
  company_id VARCHAR(255) NOT NULL REFERENCES companies ON DELETE CASCADE,
  city_id BIGINT NOT NULL REFERENCES cities ON DELETE CASCADE,
  delivery_fee NUMERIC(10,2),
  lowest_price_standard NUMERIC(10,2),
  lowest_price_menu_config NUMERIC(10,2),
  orders_enabled BOOLEAN,
  delivery_enabled BOOLEAN,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  observations  INT NOT NULL DEFAULT 1 CHECK (observations > 0),
  closed_at     TIMESTAMPTZ,
  CHECK (last_seen_at >= first_seen_at),
  CHECK (closed_at IS NULL OR closed_at >= last_seen_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS company_city_history_open_key
  ON company_city_history (company_id, city_id)
  WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS company_city_history_series
  ON company_city_history (company_id, city_id, first_seen_at);
