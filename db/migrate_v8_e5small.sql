-- v8: switch production embeddings from bge-m3 (1024d) to e5-small (384d).
--
-- The new model wins MAP/NDCG/AUROC across all 4 LLM oracles in the v2 bench
-- (see EMBEDDINGS.md), is 6× faster per embed, and 2.7× smaller per vector.
--
-- Destructive: TRUNCATEs both embedding tables. Run `npm run embed`
-- immediately afterwards to refill `meal_embeddings`. `keyword_embeddings`
-- is a cache and will refill itself on demand as users hit the dashboard.
--
-- Why DROP/recreate (not ALTER): pgvector's vector(N) is a parameterised
-- type, not a base type. ALTER COLUMN ... TYPE vector(384) USING ...
-- would need a cast expression that doesn't exist, and the column would
-- carry stale 1024-d data anyway. Cleanest path is drop + recreate.

BEGIN;

-- ── 1. meal_embeddings ──────────────────────────────────────────────────────
DROP VIEW IF EXISTS current_meal_embeddings;

DROP TABLE IF EXISTS meal_embeddings CASCADE;

CREATE TABLE meal_embeddings (
  meal_id      BIGINT      NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
  embedded_fp  TEXT        NOT NULL,
  embedding    vector(384) NOT NULL,
  embedded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (meal_id, embedded_fp)
);

CREATE INDEX ON meal_embeddings USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON meal_embeddings (meal_id, embedded_at DESC);

CREATE OR REPLACE VIEW current_meal_embeddings AS
  SELECT DISTINCT ON (meal_id) meal_id, embedded_fp, embedding, embedded_at
    FROM meal_embeddings
   ORDER BY meal_id, embedded_at DESC;

-- ── 2. keyword_embeddings (cache, also reset) ───────────────────────────────
DROP TABLE IF EXISTS keyword_embeddings CASCADE;

CREATE TABLE keyword_embeddings (
  keyword       TEXT        PRIMARY KEY,
  embedding     vector(384) NOT NULL,
  last_used_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON keyword_embeddings (last_used_at DESC);

-- ── 3. Sanity ───────────────────────────────────────────────────────────────
-- After this migration, run:
--   npm run embed                          -- refill meal_embeddings (~3 min)
-- The keyword cache fills lazily on first dashboard query per keyword.

COMMIT;
