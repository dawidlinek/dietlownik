-- v10: performance indexes for getRankedOffersForDay.
--
-- Three problems we're fixing:
--
--   1. The hot path filters `daily_menu` by (city_id, menu_date), but
--      city_id is in NO existing index, and menu_date is only the 2nd
--      column of `idx_daily_menu_lookup` (behind company_id). Postgres
--      can't satisfy that filter via an index — every call seq-scans the
--      whole event-log table.
--
--   2. `prices` is filtered by city_id, but city_id is only the 2nd
--      column of an existing index (behind company_id). Same skip-scan
--      problem.
--
--   3. The ingredient channel uses `word_similarity(stem, name) >= 0.6`,
--      which requires the `<%` operator backed by a `gist_trgm_ops`
--      index. The existing trigram indexes are `gin_trgm_ops`, which
--      only support LIKE / `%` and don't help word_similarity.

CREATE INDEX IF NOT EXISTS idx_daily_menu_city_date
  ON daily_menu (city_id, menu_date, company_id, diet_calories_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_prices_city_captured
  ON prices (city_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_meal_ingredients_name_gist
  ON meal_ingredients USING gist (name_normalized gist_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_meals_name_gist
  ON meals USING gist (name_normalized gist_trgm_ops);
