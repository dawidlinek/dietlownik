-- v7: embedding benchmark infrastructure.
--
--   bench_queries        — the curated query set (zdrowe, kurczak, na łuszczycy, ...)
--   bench_label_jobs     — work units; one row per (query, batch) needing a label run
--   bench_label_job_items— the meals in each batch
--   bench_labels         — the actual scores from the LLM oracle (0-10 per meal,query)
--   bench_runs           — one row per (model, eval pass) with aggregate metrics
--   bench_run_per_query  — per-(model,query) metric breakdown
--
-- All bench_* tables are append-only / cache-style and safe to truncate +
-- re-populate without touching the core data warehouse. They live in the same
-- DB because they reference `meals.id` directly (FK with ON DELETE CASCADE) so
-- that pruning the meal corpus auto-prunes orphaned labels.

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid for run_id

-- ── 1. bench_queries ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bench_queries (
  query_id          SERIAL       PRIMARY KEY,
  query_text        TEXT         NOT NULL UNIQUE,
  query_family      TEXT         NOT NULL,
  expected_channel  TEXT,          -- 'embedding' | 'category' | 'tag' | 'macro' | 'allergen' | 'composite' | NULL=unknown
  label_source      TEXT NOT NULL  -- 'llm' | 'auto' (auto = derived from structured fields)
                    CHECK (label_source IN ('llm', 'auto')),
  notes             TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bench_queries_family ON bench_queries (query_family);

-- ── 2. bench_label_jobs + items ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bench_label_jobs (
  job_id        BIGSERIAL    PRIMARY KEY,
  query_id      INT          NOT NULL REFERENCES bench_queries(query_id) ON DELETE CASCADE,
  batch_index   INT          NOT NULL,                  -- 0..N for the query's batches
  status        TEXT         NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'in_progress', 'done', 'failed')),
  labeler_model TEXT,                                   -- e.g. 'claude-sonnet-4-5'
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  error         TEXT,
  UNIQUE (query_id, batch_index)
);

CREATE INDEX IF NOT EXISTS idx_bench_label_jobs_status
  ON bench_label_jobs (status, query_id);

CREATE TABLE IF NOT EXISTS bench_label_job_items (
  job_id   BIGINT NOT NULL REFERENCES bench_label_jobs(job_id) ON DELETE CASCADE,
  meal_id  BIGINT NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
  stratum  TEXT,   -- 'text_match' | 'embedding_pool' | 'random' | other
  PRIMARY KEY (job_id, meal_id)
);

CREATE INDEX IF NOT EXISTS idx_bench_job_items_meal
  ON bench_label_job_items (meal_id);

-- ── 3. bench_labels ─────────────────────────────────────────────────────────
-- Labels are keyed by (query, meal, labeler_model) so we can re-label with a
-- stronger model later without losing the original judgment.
CREATE TABLE IF NOT EXISTS bench_labels (
  query_id      INT     NOT NULL REFERENCES bench_queries(query_id) ON DELETE CASCADE,
  meal_id       BIGINT  NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
  labeler_model TEXT    NOT NULL,
  score         NUMERIC(4,1) NOT NULL CHECK (score >= 0 AND score <= 10),
  reason        TEXT,
  job_id        BIGINT  REFERENCES bench_label_jobs(job_id) ON DELETE SET NULL,
  labeled_at    TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (query_id, meal_id, labeler_model)
);

CREATE INDEX IF NOT EXISTS idx_bench_labels_query
  ON bench_labels (query_id, score DESC);
CREATE INDEX IF NOT EXISTS idx_bench_labels_meal
  ON bench_labels (meal_id);

-- ── 4. bench_runs (one per model evaluation pass) ───────────────────────────
-- Evaluation is always restricted to a single (city, day) — the production
-- scoring query joins offer_slots_kcal which is itself a city+day+kcal slice,
-- so an extrinsic per-day eval is the only one that matters for shipping.
CREATE TABLE IF NOT EXISTS bench_runs (
  run_id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id        TEXT         NOT NULL,               -- e.g. 'mmlw-retrieval-e5-large'
  model_hf_id     TEXT         NOT NULL,               -- e.g. 'sdadas/mmlw-retrieval-e5-large'
  embed_dim       INT          NOT NULL,
  passage_prefix  TEXT,                                -- e.g. 'passage: ' (e5-family)
  query_prefix    TEXT,                                -- e.g. 'query: '
  labeler_model   TEXT         NOT NULL,               -- which labels were scored against
  scope_city_id   BIGINT       NOT NULL REFERENCES cities(city_id),
  scope_day       DATE         NOT NULL,
  meal_count      INT          NOT NULL,               -- distinct meals on offer in (city, day)
  query_count     INT          NOT NULL,
  started_at      TIMESTAMPTZ  DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  -- Aggregate metrics across all queries (means)
  mean_map        NUMERIC(6,4),
  mean_ndcg_10    NUMERIC(6,4),
  mean_auroc      NUMERIC(6,4),
  mean_recall_10  NUMERIC(6,4),
  mean_recall_50  NUMERIC(6,4),
  notes           TEXT
);

CREATE INDEX IF NOT EXISTS idx_bench_runs_scope
  ON bench_runs (scope_city_id, scope_day, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_bench_runs_model ON bench_runs (model_id, started_at DESC);

-- Drop the old (city/day-less) bench_runs index if a previous v7 install made one.
-- No-op on first install.

-- ── 5. bench_run_per_query (per-query metric breakdown for a run) ───────────
CREATE TABLE IF NOT EXISTS bench_run_per_query (
  run_id        UUID    NOT NULL REFERENCES bench_runs(run_id) ON DELETE CASCADE,
  query_id      INT     NOT NULL REFERENCES bench_queries(query_id) ON DELETE CASCADE,
  query_family  TEXT    NOT NULL,                       -- denormalised for fast group-by
  pool_size     INT     NOT NULL,                       -- labeled meals for this query
  positives     INT     NOT NULL,                       -- meals with score >= 7
  map           NUMERIC(6,4),
  ndcg_10       NUMERIC(6,4),
  auroc         NUMERIC(6,4),
  recall_10     NUMERIC(6,4),
  recall_50     NUMERIC(6,4),
  PRIMARY KEY (run_id, query_id)
);

CREATE INDEX IF NOT EXISTS idx_bench_rpq_family
  ON bench_run_per_query (run_id, query_family);
