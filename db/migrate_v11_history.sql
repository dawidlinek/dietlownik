-- v11: event logs → spans, dish content → variants, one embedding per variant.
--
-- Upgrades a v10 database in place. Run through `node db/migrate_v11_history.js`,
-- which executes every `-- @step` below inside ONE transaction (any failure
-- rolls the whole thing back) and prints per-step timings.
--
-- What is exact and what is reconstructed:
--
--   prices → price_history         exact. Every legacy row is covered by a
--                                  span with identical values; sum of
--                                  observations = legacy row count.
--   daily_menu → menu_items        presence is exact (same checks), and
--                                  absence is exact relative to the fetches
--                                  that returned rows: each fetch's rows share
--                                  one captured_at, so a span closes at the
--                                  first fetch of its menu that lacked it.
--   variant + macros per option    reconstructed. Legacy daily_menu stored
--                                  only meal_id; the served content lived on a
--                                  meals row that every fetch overwrote. The
--                                  scraper wrote the meal (and, on change, an
--                                  ingredient snapshot) just before the menu
--                                  rows of the same fetch, so the snapshot
--                                  current at captured_at identifies what that
--                                  fetch saw. Concurrent fetches of the same
--                                  dish can interleave; that residue is small
--                                  and unrecoverable.
--   reviews per option             approximate: nearest earlier meals_history
--                                  row, else the dish's last-known value.
--   variant label/thermo/allergens copied from the dish's last-known values
--                                  (never recorded per version). Marked
--                                  origin = 'v11-backfill'.
--
-- Nothing is deleted here. The superseded tables are renamed legacy_*;
-- `--verify` checks the conversion and `--finalize` drops only the ones
-- whose content is now fully held by the new tables.

-- @step preflight
DO $$
BEGIN
  IF to_regclass('public.menu_items') IS NOT NULL THEN
    RAISE EXCEPTION 'v11 already applied: menu_items exists';
  END IF;
  IF to_regclass('public.daily_menu') IS NULL
     OR to_regclass('public.meal_ingredients_snapshots') IS NULL THEN
    RAISE EXCEPTION 'not a v10 database: daily_menu / meal_ingredients_snapshots missing';
  END IF;
END $$;

-- @step rename-legacy
DROP VIEW IF EXISTS current_daily_menu;
DROP VIEW IF EXISTS current_meal_embeddings;
ALTER TABLE daily_menu                 RENAME TO legacy_daily_menu;
ALTER TABLE prices                     RENAME TO legacy_prices;
ALTER TABLE meals_history              RENAME TO legacy_meals_history;
ALTER TABLE meal_ingredients_snapshots RENAME TO legacy_meal_ingredients_snapshots;
ALTER TABLE meal_embeddings            RENAME TO legacy_meal_embeddings;
ALTER TABLE meal_ingredients           RENAME TO legacy_meal_ingredients;
-- Indexes keep their names across a table rename; free the ones the new
-- tables want and drop the ones nothing will query again.
ALTER INDEX meal_ingredients_pkey RENAME TO legacy_meal_ingredients_pkey;
DROP INDEX IF EXISTS meal_ingredients_name_normalized_idx;
DROP INDEX IF EXISTS meal_ingredients_name_normalized_idx1;
DROP INDEX IF EXISTS idx_meal_ingredients_name_gist;
DROP INDEX IF EXISTS meal_embeddings_embedding_idx;
DROP INDEX IF EXISTS idx_daily_menu_city_date;
DROP INDEX IF EXISTS daily_menu_meal_id_menu_date_idx;
DROP INDEX IF EXISTS idx_prices_city_captured;
DROP INDEX IF EXISTS prices_company_id_city_id_captured_at_idx;
DROP INDEX IF EXISTS prices_captured_at_idx;
DROP INDEX IF EXISTS prices_diet_calories_id_order_days_captured_at_idx;

-- @step scrape-log
CREATE TABLE scrape_runs (
  run_id BIGSERIAL PRIMARY KEY,
  cmd TEXT NOT NULL,
  scope TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'ok', 'partial', 'failed')),
  ok_count INT,
  fail_count INT
);
CREATE INDEX ON scrape_runs (started_at DESC);
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

-- @step campaigns
-- Global campaigns (company_id NULL) were duplicated on every scrape because
-- a plain UNIQUE treats NULLs as distinct. Keep the most recently seen copy.
DELETE FROM campaigns c
USING campaigns d
WHERE c.company_id IS NULL AND d.company_id IS NULL
  AND c.code IS NOT DISTINCT FROM d.code
  AND (COALESCE(d.last_seen_at, '-infinity'), d.id)
    > (COALESCE(c.last_seen_at, '-infinity'), c.id);
ALTER TABLE campaigns DROP CONSTRAINT campaigns_company_id_code_key;
ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_company_id_code_key UNIQUE NULLS NOT DISTINCT (company_id, code);
-- Unknown for rows that predate the column; set for new ones.
ALTER TABLE campaigns ADD COLUMN first_seen_at TIMESTAMPTZ;
ALTER TABLE campaigns ALTER COLUMN first_seen_at SET DEFAULT NOW();

-- @step content-sha-function
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

-- @step variant-tables
CREATE TABLE meal_variants (
  id BIGSERIAL PRIMARY KEY,
  meal_id BIGINT NOT NULL REFERENCES meals ON DELETE CASCADE,
  content_sha TEXT NOT NULL,
  label VARCHAR(255),
  thermo VARCHAR(20),
  allergens TEXT[] NOT NULL DEFAULT '{}',
  ingredients_raw TEXT,
  origin TEXT NOT NULL DEFAULT 'scrape' CHECK (origin IN ('scrape', 'v11-backfill')),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (meal_id, content_sha)
);
CREATE TABLE meal_ingredients (
  variant_id BIGINT NOT NULL REFERENCES meal_variants ON DELETE CASCADE,
  position INT NOT NULL,
  name_raw TEXT NOT NULL,
  name_normalized TEXT NOT NULL,
  is_major BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (variant_id, position)
);

-- @step snapshot-contents
-- One row per legacy snapshot, reduced to (dish, time, fingerprint, content).
CREATE TEMP TABLE snap AS
SELECT s.id, s.meal_id, s.captured_at, s.fingerprint,
       md5(s.ingredients::text) AS ing_md5
FROM legacy_meal_ingredients_snapshots s;
-- The dish's latest snapshot: the content its meals row still describes.
CREATE TEMP TABLE snap_latest AS
SELECT DISTINCT ON (meal_id) meal_id, ing_md5
FROM snap
ORDER BY meal_id, captured_at DESC, id DESC;
-- Distinct contents per dish, with one representative snapshot each.
CREATE TEMP TABLE snap_content AS
SELECT meal_id, ing_md5,
       (array_agg(id ORDER BY id))[1] AS rep_snapshot_id,
       min(captured_at) AS first_at,
       max(captured_at) AS last_at
FROM snap
GROUP BY meal_id, ing_md5;
ANALYZE snap; ANALYZE snap_content; ANALYZE snap_latest;

-- @step build-variants
CREATE TEMP TABLE content_variant AS
SELECT sc.meal_id, sc.ing_md5, sc.rep_snapshot_id, sc.first_at, sc.last_at,
       meal_content_sha(m.label, m.thermo, m.allergens, s.ingredients) AS content_sha,
       ing.ingredients_raw,
       -- Latest content, and the meals row agrees with it: label, thermo and
       -- allergens were genuinely observed together with this list.
       (sl.meal_id IS NOT NULL
        AND ing.ingredients_raw IS NOT DISTINCT FROM m.ingredients_raw) AS observed
FROM snap_content sc
JOIN legacy_meal_ingredients_snapshots s ON s.id = sc.rep_snapshot_id
JOIN meals m ON m.id = sc.meal_id
LEFT JOIN snap_latest sl ON sl.meal_id = sc.meal_id AND sl.ing_md5 = sc.ing_md5
CROSS JOIN LATERAL (
  SELECT string_agg(e->>'name_raw', '; ' ORDER BY (e->>'position')::int) AS ingredients_raw
  FROM jsonb_array_elements(s.ingredients) e
) ing;

INSERT INTO meal_variants
  (meal_id, content_sha, label, thermo, allergens, ingredients_raw, origin,
   first_seen_at, last_seen_at)
SELECT cv.meal_id, cv.content_sha, m.label, m.thermo, COALESCE(m.allergens, '{}'),
       (array_agg(cv.ingredients_raw ORDER BY cv.rep_snapshot_id))[1],
       CASE WHEN bool_or(cv.observed) THEN 'scrape' ELSE 'v11-backfill' END,
       min(cv.first_at), max(cv.last_at)
FROM content_variant cv
JOIN meals m ON m.id = cv.meal_id
GROUP BY cv.meal_id, cv.content_sha, m.label, m.thermo, m.allergens;

INSERT INTO meal_ingredients (variant_id, position, name_raw, name_normalized, is_major)
SELECT v.id, (e->>'position')::int, e->>'name_raw', e->>'name_normalized',
       COALESCE((e->>'is_major')::boolean, FALSE)
FROM (
  SELECT DISTINCT ON (meal_id, content_sha) meal_id, content_sha, rep_snapshot_id
  FROM content_variant
  ORDER BY meal_id, content_sha, rep_snapshot_id
) rep
JOIN meal_variants v ON v.meal_id = rep.meal_id AND v.content_sha = rep.content_sha
JOIN legacy_meal_ingredients_snapshots s ON s.id = rep.rep_snapshot_id
CROSS JOIN LATERAL jsonb_array_elements(s.ingredients) e;

CREATE INDEX ON meal_ingredients USING gin (name_normalized gin_trgm_ops);

-- snapshot → variant, for attributing menu observations.
CREATE TEMP TABLE snap_variant AS
SELECT s.meal_id, s.captured_at, s.fingerprint, v.id AS variant_id
FROM snap s
JOIN content_variant cv ON cv.meal_id = s.meal_id AND cv.ing_md5 = s.ing_md5
JOIN meal_variants v ON v.meal_id = cv.meal_id AND v.content_sha = cv.content_sha;
CREATE INDEX ON snap_variant (meal_id, captured_at DESC) INCLUDE (fingerprint, variant_id);
ANALYZE snap_variant;

-- @step macro-sources
-- A fingerprint covers the macros, so equal fingerprints mean equal macros.
-- meals_history never recorded a dish's FIRST state, but the first state's
-- fingerprint usually recurs later (the flapping), which recovers it.
CREATE TEMP TABLE fp_macros AS
SELECT DISTINCT ON (meal_id, fingerprint)
  meal_id, fingerprint, kcal, protein_g, fat_g, carbs_g, fiber_g, sugar_g,
  saturated_fat_g, salt_g
FROM (
  SELECT meal_id, fingerprint, kcal, protein_g, fat_g, carbs_g, fiber_g, sugar_g,
         saturated_fat_g, salt_g, captured_at
  FROM legacy_meals_history
  UNION ALL
  SELECT id, fingerprint, kcal, protein_g, fat_g, carbs_g, fiber_g, sugar_g,
         saturated_fat_g, salt_g, updated_at
  FROM meals
) x
WHERE fingerprint IS NOT NULL
ORDER BY meal_id, fingerprint, captured_at DESC;
CREATE UNIQUE INDEX ON fp_macros (meal_id, fingerprint);

CREATE TEMP TABLE hist_reviews AS
SELECT meal_id, captured_at, reviews_score, reviews_number
FROM legacy_meals_history;
CREATE INDEX ON hist_reviews (meal_id, captured_at DESC) INCLUDE (reviews_score, reviews_number);
ANALYZE fp_macros; ANALYZE hist_reviews;

-- @step attribute-menu
-- Every legacy menu row, with the variant, macros and reviews its fetch saw.
CREATE TEMP TABLE menu_obs AS
SELECT dm.company_id, dm.city_id, dm.diet_calories_id, dm.tier_id, dm.menu_date,
       dm.api_meal_slot_id, dm.captured_at,
       dm.slot_name, dm.meal_id, sv.variant_id, dm.is_default,
       fm.kcal, fm.protein_g, fm.fat_g, fm.carbs_g, fm.fiber_g, fm.sugar_g,
       fm.saturated_fat_g, fm.salt_g,
       COALESCE(hr.reviews_score,  CASE WHEN hr.meal_id IS NULL THEN m.reviews_score  END) AS reviews_score,
       COALESCE(hr.reviews_number, CASE WHEN hr.meal_id IS NULL THEN m.reviews_number END) AS reviews_number
FROM legacy_daily_menu dm
JOIN meals m ON m.id = dm.meal_id
LEFT JOIN LATERAL (
  SELECT s.fingerprint, s.variant_id
  FROM snap_variant s
  WHERE s.meal_id = dm.meal_id AND s.captured_at <= dm.captured_at
  ORDER BY s.captured_at DESC
  LIMIT 1
) sv ON TRUE
LEFT JOIN fp_macros fm ON fm.meal_id = dm.meal_id AND fm.fingerprint = sv.fingerprint
LEFT JOIN LATERAL (
  SELECT h.meal_id, h.reviews_score, h.reviews_number
  FROM hist_reviews h
  WHERE h.meal_id = dm.meal_id AND h.captured_at <= dm.captured_at
  ORDER BY h.captured_at DESC
  LIMIT 1
) hr ON TRUE;

-- @step menu-spans
-- Each fetch of one menu (scope) wrote all its rows with a single NOW(), so
-- distinct captured_at per scope = the sequence of fetches that returned rows.
CREATE TEMP TABLE menu_fetches AS
SELECT company_id, city_id, diet_calories_id, tier_id, menu_date, captured_at,
       row_number() OVER w AS seq,
       lead(captured_at) OVER w AS next_fetch_at
FROM (
  SELECT DISTINCT company_id, city_id, diet_calories_id, tier_id, menu_date, captured_at
  FROM legacy_daily_menu
) f
WINDOW w AS (PARTITION BY company_id, city_id, diet_calories_id, tier_id, menu_date
             ORDER BY captured_at);

CREATE TABLE menu_items (
  id BIGSERIAL PRIMARY KEY,
  company_id VARCHAR(255) NOT NULL,
  city_id BIGINT NOT NULL REFERENCES cities,
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
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  observations  INT NOT NULL DEFAULT 1 CHECK (observations > 0),
  closed_at     TIMESTAMPTZ,
  CHECK (last_seen_at >= first_seen_at),
  CHECK (closed_at IS NULL OR closed_at >= last_seen_at),
  FOREIGN KEY (company_id, diet_calories_id)
    REFERENCES diet_calories ON DELETE CASCADE
);

-- A new span starts when the option was missing from the previous fetch of
-- its menu, when its values changed, or after a > 36 h silence.
INSERT INTO menu_items
  (company_id, city_id, diet_calories_id, tier_id, menu_date, api_meal_slot_id,
   slot_name, meal_id, variant_id, is_default,
   kcal, protein_g, fat_g, carbs_g, fiber_g, sugar_g, saturated_fat_g, salt_g,
   reviews_score, reviews_number,
   first_seen_at, last_seen_at, observations, closed_at)
SELECT company_id, city_id, diet_calories_id, tier_id, menu_date, api_meal_slot_id,
       slot_name, meal_id, variant_id, is_default,
       kcal, protein_g, fat_g, carbs_g, fiber_g, sugar_g, saturated_fat_g, salt_g,
       reviews_score, reviews_number,
       min(captured_at), max(captured_at), count(*)::int,
       (array_agg(next_fetch_at ORDER BY seq DESC))[1]
FROM (
  SELECT o.*, sum(new_span) OVER k AS span_no
  FROM (
    SELECT o.*, f.seq, f.next_fetch_at,
      CASE
        WHEN lag(f.seq) OVER k IS NULL THEN 1
        WHEN f.seq <> lag(f.seq) OVER k + 1 THEN 1
        WHEN o.captured_at - lag(o.captured_at) OVER k > INTERVAL '36 hours' THEN 1
        WHEN ROW(o.slot_name, o.meal_id, o.variant_id, o.is_default,
                 o.kcal, o.protein_g, o.fat_g, o.carbs_g, o.fiber_g, o.sugar_g,
                 o.saturated_fat_g, o.salt_g, o.reviews_score, o.reviews_number)
             IS DISTINCT FROM
             lag(ROW(o.slot_name, o.meal_id, o.variant_id, o.is_default,
                 o.kcal, o.protein_g, o.fat_g, o.carbs_g, o.fiber_g, o.sugar_g,
                 o.saturated_fat_g, o.salt_g, o.reviews_score, o.reviews_number)) OVER k
          THEN 1
        ELSE 0
      END AS new_span
    FROM menu_obs o
    JOIN menu_fetches f USING (company_id, city_id, diet_calories_id, tier_id, menu_date, captured_at)
    WINDOW k AS (PARTITION BY o.company_id, o.city_id, o.diet_calories_id, o.tier_id,
                              o.menu_date, o.api_meal_slot_id
                 ORDER BY f.seq)
  ) o
  WINDOW k AS (PARTITION BY company_id, city_id, diet_calories_id, tier_id,
                            menu_date, api_meal_slot_id
               ORDER BY seq)
) spans
GROUP BY company_id, city_id, diet_calories_id, tier_id, menu_date, api_meal_slot_id,
         span_no,
         slot_name, meal_id, variant_id, is_default,
         kcal, protein_g, fat_g, carbs_g, fiber_g, sugar_g, saturated_fat_g, salt_g,
         reviews_score, reviews_number;

CREATE UNIQUE INDEX menu_items_open_key
  ON menu_items (company_id, city_id, diet_calories_id, tier_id, menu_date, api_meal_slot_id)
  WHERE closed_at IS NULL;
CREATE INDEX menu_items_open_city_date
  ON menu_items (city_id, menu_date, company_id, diet_calories_id)
  WHERE closed_at IS NULL;
CREATE INDEX menu_items_history
  ON menu_items (company_id, diet_calories_id, menu_date, first_seen_at);
CREATE INDEX ON menu_items (meal_id);
CREATE INDEX ON menu_items (variant_id);
CREATE VIEW current_menu_items AS
SELECT * FROM menu_items WHERE closed_at IS NULL;

-- Variant lifetimes from what menus actually served.
UPDATE meal_variants v
SET first_seen_at = LEAST(v.first_seen_at, x.first_at),
    last_seen_at  = GREATEST(v.last_seen_at, x.last_at)
FROM (
  SELECT variant_id, min(first_seen_at) AS first_at, max(last_seen_at) AS last_at
  FROM menu_items WHERE variant_id IS NOT NULL GROUP BY variant_id
) x
WHERE x.variant_id = v.id;

-- @step price-spans
CREATE TABLE price_history (
  id BIGSERIAL PRIMARY KEY,
  diet_calories_id INT NOT NULL,
  company_id VARCHAR(255) NOT NULL,
  city_id BIGINT NOT NULL REFERENCES cities,
  order_days INT NOT NULL,
  promo_codes TEXT[] NOT NULL DEFAULT '{}',
  per_day_cost                NUMERIC(10,2),
  total_cost                  NUMERIC(10,2),
  total_cost_without_discounts NUMERIC(10,2),
  total_lowest_30days_cost_without_discounts NUMERIC(10,2),
  total_delivery_cost         NUMERIC(10,2),
  total_delivery_discount     NUMERIC(10,2),
  total_promo_code_discount   NUMERIC(10,2),
  total_promo_code_discount_info TEXT,
  total_order_length_discount NUMERIC(10,2),
  total_deliveries_on_date_discount NUMERIC(10,2),
  total_loyalty_points_discount NUMERIC(10,2),
  total_pickup_point_discount NUMERIC(10,2),
  total_one_time_side_orders_cost NUMERIC(10,2),
  total_awarded_loyalty_program_points        INT,
  total_awarded_global_loyalty_program_points INT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  observations  INT NOT NULL DEFAULT 1 CHECK (observations > 0),
  closed_at     TIMESTAMPTZ,
  CHECK (last_seen_at >= first_seen_at),
  CHECK (closed_at IS NULL OR closed_at >= last_seen_at),
  FOREIGN KEY (company_id, diet_calories_id)
    REFERENCES diet_calories ON DELETE CASCADE
);

-- A quote is fetched per key, so there is no "missing from a fetch": a span
-- ends when the values change or after a > 36 h silence, and closes at the
-- observation that ended it.
INSERT INTO price_history
  (diet_calories_id, company_id, city_id, order_days, promo_codes,
   per_day_cost, total_cost, total_cost_without_discounts,
   total_lowest_30days_cost_without_discounts,
   total_delivery_cost, total_delivery_discount,
   total_promo_code_discount, total_promo_code_discount_info,
   total_order_length_discount, total_deliveries_on_date_discount,
   total_loyalty_points_discount, total_pickup_point_discount,
   total_one_time_side_orders_cost,
   total_awarded_loyalty_program_points, total_awarded_global_loyalty_program_points,
   first_seen_at, last_seen_at, observations, closed_at)
SELECT diet_calories_id, company_id, city_id, order_days, promo_codes,
       per_day_cost, total_cost, total_cost_without_discounts,
       total_lowest_30days_cost_without_discounts,
       total_delivery_cost, total_delivery_discount,
       total_promo_code_discount, total_promo_code_discount_info,
       total_order_length_discount, total_deliveries_on_date_discount,
       total_loyalty_points_discount, total_pickup_point_discount,
       total_one_time_side_orders_cost,
       total_awarded_loyalty_program_points, total_awarded_global_loyalty_program_points,
       min(captured_at), max(captured_at), count(*)::int,
       (array_agg(next_at ORDER BY captured_at DESC, id DESC))[1]
FROM (
  SELECT p.*, sum(new_span) OVER k AS span_no
  FROM (
    SELECT p.*,
      lead(p.captured_at) OVER k AS next_at,
      CASE
        WHEN lag(p.captured_at) OVER k IS NULL THEN 1
        WHEN p.captured_at - lag(p.captured_at) OVER k > INTERVAL '36 hours' THEN 1
        WHEN ROW(p.per_day_cost, p.total_cost, p.total_cost_without_discounts,
                 p.total_lowest_30days_cost_without_discounts,
                 p.total_delivery_cost, p.total_delivery_discount,
                 p.total_promo_code_discount, p.total_promo_code_discount_info,
                 p.total_order_length_discount, p.total_deliveries_on_date_discount,
                 p.total_loyalty_points_discount, p.total_pickup_point_discount,
                 p.total_one_time_side_orders_cost,
                 p.total_awarded_loyalty_program_points,
                 p.total_awarded_global_loyalty_program_points)
             IS DISTINCT FROM
             lag(ROW(p.per_day_cost, p.total_cost, p.total_cost_without_discounts,
                 p.total_lowest_30days_cost_without_discounts,
                 p.total_delivery_cost, p.total_delivery_discount,
                 p.total_promo_code_discount, p.total_promo_code_discount_info,
                 p.total_order_length_discount, p.total_deliveries_on_date_discount,
                 p.total_loyalty_points_discount, p.total_pickup_point_discount,
                 p.total_one_time_side_orders_cost,
                 p.total_awarded_loyalty_program_points,
                 p.total_awarded_global_loyalty_program_points)) OVER k
          THEN 1
        ELSE 0
      END AS new_span
    FROM legacy_prices p
    WINDOW k AS (PARTITION BY p.company_id, p.diet_calories_id, p.city_id,
                              p.order_days, p.promo_codes
                 ORDER BY p.captured_at, p.id)
  ) p
  WINDOW k AS (PARTITION BY company_id, diet_calories_id, city_id, order_days, promo_codes
               ORDER BY captured_at, id)
) spans
GROUP BY company_id, diet_calories_id, city_id, order_days, promo_codes, span_no,
         per_day_cost, total_cost, total_cost_without_discounts,
         total_lowest_30days_cost_without_discounts,
         total_delivery_cost, total_delivery_discount,
         total_promo_code_discount, total_promo_code_discount_info,
         total_order_length_discount, total_deliveries_on_date_discount,
         total_loyalty_points_discount, total_pickup_point_discount,
         total_one_time_side_orders_cost,
         total_awarded_loyalty_program_points, total_awarded_global_loyalty_program_points;

CREATE UNIQUE INDEX price_history_open_key
  ON price_history (company_id, diet_calories_id, city_id, order_days, promo_codes)
  WHERE closed_at IS NULL;
CREATE INDEX price_history_open_city
  ON price_history (city_id, company_id, diet_calories_id)
  WHERE closed_at IS NULL;
CREATE INDEX price_history_series
  ON price_history (company_id, diet_calories_id, city_id, first_seen_at);
CREATE VIEW current_prices AS
SELECT * FROM price_history WHERE closed_at IS NULL;

-- @step embeddings
-- Each legacy vector was computed from the dish's content at the time,
-- identified by the dish fingerprint. The one whose fingerprint is the
-- dish's current one embeds exactly the current ('scrape') variant's
-- passage; carry those over. Every other variant is embedded by `embed`.
CREATE TABLE variant_embeddings (
  variant_id BIGINT PRIMARY KEY REFERENCES meal_variants ON DELETE CASCADE,
  passage_version SMALLINT NOT NULL,
  embedding vector(384) NOT NULL,
  embedded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO variant_embeddings (variant_id, passage_version, embedding, embedded_at)
SELECT DISTINCT ON (v.id) v.id, 1, e.embedding, e.embedded_at
FROM meals m
JOIN snap_latest sl ON sl.meal_id = m.id
JOIN content_variant cv
  ON cv.meal_id = sl.meal_id AND cv.ing_md5 = sl.ing_md5 AND cv.observed
JOIN meal_variants v ON v.meal_id = cv.meal_id AND v.content_sha = cv.content_sha
JOIN legacy_meal_embeddings e ON e.meal_id = m.id AND e.embedded_fp = m.fingerprint
ORDER BY v.id, e.embedded_at DESC;

-- @step slim-meals
-- Content and portion numbers now live on meal_variants / menu_items.
DROP INDEX IF EXISTS meals_company_id_lower_idx;
DROP INDEX IF EXISTS idx_meals_name_gist;
ALTER TABLE meals
  DROP COLUMN label,
  DROP COLUMN thermo,
  DROP COLUMN kcal,
  DROP COLUMN protein_g,
  DROP COLUMN fat_g,
  DROP COLUMN carbs_g,
  DROP COLUMN fiber_g,
  DROP COLUMN sugar_g,
  DROP COLUMN saturated_fat_g,
  DROP COLUMN salt_g,
  DROP COLUMN reviews_score,
  DROP COLUMN reviews_number,
  DROP COLUMN allergens,
  DROP COLUMN ingredients_raw,
  DROP COLUMN fingerprint,
  DROP COLUMN updated_at;
ALTER TABLE meals ALTER COLUMN first_seen_at SET NOT NULL;
ALTER TABLE meals ALTER COLUMN last_seen_at SET NOT NULL;
-- The per-dish ingredient table is fully contained in the snapshots.
DROP TABLE legacy_meal_ingredients;

CREATE VIEW meal_latest_variant AS
SELECT DISTINCT ON (v.meal_id)
  v.meal_id, v.id AS variant_id, v.label, v.thermo, v.allergens,
  v.ingredients_raw, v.origin, v.first_seen_at, v.last_seen_at
FROM meal_variants v
ORDER BY v.meal_id, v.last_seen_at DESC, v.id DESC;

-- @step analyze
ANALYZE meals;
ANALYZE meal_variants;
ANALYZE meal_ingredients;
ANALYZE menu_items;
ANALYZE price_history;
ANALYZE variant_embeddings;
ANALYZE campaigns;
