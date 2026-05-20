# Embeddings — how meal-keyword matching works

A walk-through of the embedding pipeline: from scrape to live dashboard
ranking. Includes the bench-driven model choice (e5-small over bge-m3) and
the calibrated production threshold (0.80).

---

## What the embedding channel does

The `/match` dashboard ranks day-of-offer meals against user preferences
(`prefer: kurczak, lekkie  avoid: ryby, surowe pomidory`). Each preference
keyword flows through a four-channel **router** in `lib/preference-router.ts`:

1. **allergen** — keyword matches a known allergen synonym (`gluten`, `mleko`)
2. **macro** — keyword parses to a macro rule (`dużo białka` → `protein_g high`)
3. **category** — keyword matches an `ingredient_taxonomy` entry
4. **embedding** — fallback: turn the keyword into a vector, find similar meal embeddings

The first three are exact-match channels. The embedding channel is the
soft-match fallback that catches everything else (`zdrowe`, `ostre`, `na
łuszczycy`, `kuczak`, `surowe pomidory`, ...). It's the workhorse for
real user queries, because most of what people type doesn't fit a neat
taxonomy.

This document is about that fourth channel.

---

## End-to-end pipeline

```
       (1)            (2)             (3)              (4)              (5)
  ┌──────────┐  ┌─────────────┐ ┌─────────────┐ ┌──────────────┐ ┌────────────────┐
  │  scrape  │→ │  meals row  │→│  embedding  │→│ HNSW pgvector│→│ scoring query  │
  │ dietly.pl│  │ + macros    │ │  text       │ │   index      │ │ + threshold τ  │
  └──────────┘  │ + allergens │ │   ↓ model   │ │              │ │   ↓            │
                │ + ingr_raw  │ │  vector(N)  │ │              │ │ /match ranking │
                └─────────────┘ └─────────────┘ └──────────────┘ └────────────────┘
```

### 1. Scrape (`scraper/index.ts`)

Reverse-engineered dietly.pl mobile API. Per company, we capture meals
with `name + label + ingredients_raw + allergens + kcal/protein/fat/...`.
The scraper is incremental — meal rows are upserted by `(company_id, name)`
and get a `fingerprint` that's the SHA of the canonical content.

When the fingerprint changes, the meal is considered modified — the next
embed run re-embeds it.

### 2. Embed (`scraper/scripts/embed-meals.ts`)

For every meal without a current embedding (or with a stale fingerprint),
we build a passage:

```text
Kurczak teriyaki z ryżem
Wariant: Lunch
Składniki: kurczak, ryż jaśminowy, sos teriyaki, brokuł, sezam
Alergeny: sezam, soja, gluten
```

Pass it through `getEmbedder()` (`lib/embeddings.ts`), get a vector,
store it in `meal_embeddings` keyed by `(meal_id, embedded_fp)`. The
`current_meal_embeddings` view returns the latest embedding per meal.

This runs as a one-shot (`npm run embed`) after each scrape — takes a
few minutes for ~15k meals.

### 3. Index

`meal_embeddings.embedding` has an HNSW index for cosine ops:

```sql
CREATE INDEX ON meal_embeddings USING hnsw (embedding vector_cosine_ops);
```

The current scoring query _doesn't_ use HNSW top-k retrieval (it does a
sequential scan inside the `(city, day, kcal)` candidate set, which is
~3000 meals — small enough). The index is there for future use if we
add `ORDER BY <=> $vec LIMIT N` queries.

### 4. Query at request time (`lib/queries.ts: getRankedOffersForDay`)

For each `prefer`/`avoid` keyword that fell through to the embedding
channel:

- `embedKeyword(text)` returns the vector (cached in `keyword_embeddings`
  table so repeat keywords don't re-embed)
- The scoring CTE joins `offer_slots_kcal × current_meal_embeddings ×
embedding_intents`
- For each (meal, keyword) pair, compute `1 - (embedding <=> vec)` = cosine
- Threshold: drop pairs below τ
- Rescale the remaining `[τ, 1.00]` range to `[0, 1.00]` for a per-channel
  penalty in `[0, 1]`
- Sum across channels, apply prefer/avoid weights, sort offers

### 5. Calibration — the τ and rescale divisor

These two numbers determine how aggressively the embedding channel
contributes to score:

```sql
GREATEST(0.0,
  (((1 - (embedding <=> vec))::numeric - τ) / (1 - τ))
) AS penalty
...
WHERE (1 - (embedding <=> vec))::numeric >= τ
```

Both `τ` and the divisor are _model-specific_. Picking the right values
required a benchmark.

---

## Why e5-small (not bge-m3)

### Methodology

We built a benchmark (`bench/`) that:

1. Defines **171 realistic Polish food queries** across 19 families
   (ingredient, category, macro, tag, color×category, cooking method,
   subjective, clinical, polysemy adversarials, typos, negation, …)
   — `bench/queries.json`.
2. For one (city, day) slice — Wrocław × 2026-05-20 with 2,488 distinct
   meals — samples ~100 meals per query (stratified: text-match,
   embedding-neighbour, random distractors).
3. Has 4 independent LLM oracles label every (query, meal) pair on a
   0–10 relevance scale: **Claude Opus 4.7**, **Claude Sonnet 4.5**,
   **Gemini 3 Flash**, **MiniMax M2.5**. Labels stored in `bench_labels`
   keyed by `(query, meal, labeler_model)`.
4. Embeds every meal with each candidate model
   (`scraper/scripts/bench-embed-all.ts`).
5. Computes per-query MAP / NDCG@10 / AUROC / Recall@K against each
   labeler's labels (`scraper/scripts/bench-rank.ts`).
6. Cross-validates: the same model ranked by 4 oracles should rank
   similarly. If not, something's wrong with the labels.

### Result

6 candidates were tested (e5-large failed to load on `onnxruntime-node@~1.14.0`

- Node 24 — known issue, skipped):

| Model           |  Dim |  Opus MAP | Sonnet MAP | Gemini MAP | MiniMax MAP |   **Avg** |
| --------------- | ---: | --------: | ---------: | ---------: | ----------: | --------: |
| 🥇 **e5-small** |  384 | **0.789** |  **0.510** |  **0.485** |   **0.740** | **0.631** |
| bge-m3          | 1024 |     0.720 |      0.489 |      0.428 |       0.663 |     0.575 |
| e5-base         |  768 |     0.714 |      0.470 |      0.436 |       0.645 |     0.566 |
| mpnet-multi     |  768 |     0.581 |      0.469 |      0.373 |       0.649 |     0.518 |
| labse           |  768 |     0.552 |      0.431 |      0.388 |       0.633 |     0.501 |
| minilm-multi    |  384 |     0.537 |      0.445 |      0.362 |       0.609 |     0.488 |

**e5-small wins on every labeler across MAP, NDCG@10, and AUROC.**
That's the strongest possible cross-validation — 4 oracles spanning 3
model families (Anthropic, Google, MiniMax) all picked the same winner.

It also wins on operational axes:

|                              | bge-m3 (was) | e5-small (now) |
| ---------------------------- | ------------ | -------------- |
| Dim                          | 1024         | 384            |
| ONNX weights on disk         | ~570 MB      | ~130 MB        |
| Per-meal embed (CPU)         | 75 ms        | 12 ms          |
| Server RAM                   | ~570 MB      | ~130 MB        |
| pgvector storage @ 30k meals | 168 MB       | 63 MB          |

Smaller model, faster, cheaper _and_ more accurate. The win is real.

### Why e5-small beats bge-m3

bge-m3 is designed for **long-document hybrid retrieval** (dense +
sparse + multi-vector, ~1024 dims for capacity). Our task is the
opposite — single keyword (`kurczak`) ↔ short meal description
("Kurczak w sosie curry, ryż jaśminowy"). The e5 family was trained
end-to-end on sentence-similarity tasks; bge-m3 is over-engineered
for what's effectively a short-text matching problem.

### One e5 gotcha

e5 family uses an **asymmetric prefix convention**:

- Indexed documents (meals): prepend `"passage: "` before embedding
- User queries (keywords): prepend `"query: "` before embedding

Both `embed-meals.ts` and `embedKeyword()` apply the right prefix. If
you forget the prefix, similarity scores drift out of distribution and
the threshold calibration breaks.

---

## Threshold (τ = 0.80) — how it was calibrated

`scraper/scripts/bench-threshold.ts` sweeps τ ∈ {0.50, 0.51, …, 0.95}
against the labeled set and computes precision/recall/F1 at each step.

### What we found

| Labeler    | F1-optimal τ | Precision | Recall |    F1 |
| ---------- | -----------: | --------: | -----: | ----: |
| Opus       |         0.81 |       74% |    76% | 0.751 |
| Sonnet     |         0.78 |       37% |    91% | 0.525 |
| Gemini     |         0.80 |       27% |    73% | 0.398 |
| MiniMax    |         0.79 |       67% |    81% | 0.734 |
| **median** |     **0.80** |           |        |       |

Absolute precision varies across labelers because each oracle uses a
different scoring distribution (Opus and MiniMax score in clean buckets
of 0/8–10; Sonnet and Gemini use the full 0–10 spread, making the binary
"≥7 = relevant" threshold more brittle). But the **threshold itself is
stable** at ≈ 0.80 across all 4 — that's the model property we want to
measure.

### e5-small's similarity distribution

```
τ      P (Opus)    R (Opus)
0.50   41%         100%      ← everything matches; floor precision
0.70   41%         100%
0.75   42%         100%      ← still effectively everything
0.80   65%          85%      ← good balance
0.81   74%          76%      ← max F1
0.85   93%          11%      ← cliff: high P, almost no R
0.90    0%           0%
```

The action lives entirely between 0.78 and 0.85. Below 0.70, e5-small
calls everything similar. Above 0.85, almost nothing. That tight cliff
is a known property of the e5 family — it compresses similarities
upward, which is great for thresholding (a clear "match/no-match"
signal) but means production τ must be tuned high.

### Rescale divisor

The production CTE does:

```sql
GREATEST(0.0, ((sim - τ) / (1 - τ))) AS penalty
```

With τ=0.80, the divisor `(1 - 0.80) = 0.20`. A meal at sim=0.90 gets
penalty (0.90 - 0.80) / 0.20 = **0.5**. A meal at sim=1.00 gets
penalty **1.0**. A meal at sim=0.80 gets penalty **0.0**. Everything
below 0.80 is filtered by the WHERE clause anyway.

---

## How to run the bench yourself

Once meals are scraped and `npm run embed` has filled
`meal_embeddings`, the bench is self-contained.

```bash
# One-time: tables
npm run bench:migrate

# One-time: seed query catalogue
npm run bench:init

# Each run: sample meal pools (restricts to busiest-day slice)
BENCH_DAY=2026-05-20 BENCH_RESET=1 npm run bench:sample

# Each run: embed corpus with every candidate model (slice-only)
$env:BENCH_SLICE_ONLY = "1"  # PowerShell — or  BENCH_SLICE_ONLY=1 in bash
npm run bench:embed-all

# Label every batch (Sonnet/Gemini/MiniMax/whatever LLM you have) — see
# bench/LABELING-INSTRUCTIONS.md for the agent prompt and the bench:label CLI

# Compute metrics for each labeler
BENCH_DAY=2026-05-20 BENCH_LABELER=claude-sonnet-4-5 npm run bench:rank
BENCH_DAY=2026-05-20 BENCH_LABELER=claude-opus-4-7   npm run bench:rank
# ...etc

# Render comparison report
BENCH_DAY=2026-05-20 BENCH_LABELER=claude-sonnet-4-5 npm run bench:report > bench/report.md

# Calibrate threshold
BENCH_MODELS=e5-small npm run bench:threshold

# Quick integrity check on the corpus
npm run bench:integrity
```

Total time end-to-end with ~10 LLM subagents in parallel for labeling:
roughly 2 hours. The labels persist in `bench_labels` and are reusable
across all future model comparisons — labeling is amortized.

---

## Migration: bge-m3 → e5-small

When you flip the switch:

1. **`lib/embeddings.ts`** — change `MODEL` from `Xenova/bge-m3` to
   `Xenova/multilingual-e5-small`, set `DIM = 384`, and add prefix
   handling: `"passage: " + text` in `embed()`, `"query: " + text` in
   `embedKeyword()`.
2. **Schema migration v8** — drop `meal_embeddings.embedding`,
   `keyword_embeddings.embedding`, recreate as `vector(384)`. Rebuild
   the HNSW indexes (cosine_ops works at any dim). The view
   `current_meal_embeddings` follows automatically.
3. **`lib/queries.ts`** — change τ from `0.30` to `0.80` and the
   rescale divisor from `/ 0.70` to `/ 0.20` (two locations: the
   WHERE clause and the GREATEST expression).
4. **Re-embed corpus** — truncate `meal_embeddings`, then
   `npm run embed` runs in ~3 minutes for 15k meals.
5. **Re-run extended tests** — `npm run test`. The 37-test
   `queries-ranked-multiclause.test.ts` suite is property-based and
   should pass unchanged on the new model. If anything breaks it's
   probably a hard-coded similarity expectation somewhere.

The bench results stay valid after migration — they were measured
against the slice that the new production setup will use.

---

## What to re-do, and when

| Trigger                              | What to re-run                                                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| New meals scraped                    | `npm run embed` (incremental)                                                                                          |
| Meal modified (new fingerprint)      | `npm run embed` picks up the change                                                                                    |
| Schema change to embedding table     | Schema migration + truncate + re-embed                                                                                 |
| Want to test a new candidate model   | Add to `bench/scraper/scripts/bench-candidates.ts`, `npm run bench:embed-all BENCH_MODELS=<new>`, `npm run bench:rank` |
| Re-validate winner with fresh labels | New labeler → re-run `npm run bench:label` loop, then `bench:rank --BENCH_LABELER=<new>`                               |
| Threshold seems off                  | `npm run bench:threshold` to confirm or adjust                                                                         |

The bench is designed so the _labels_ are the expensive part (LLM
calls), and they live forever in `bench_labels`. Adding a new
candidate model only requires the embed + rank steps — typically
10–15 minutes.

---

## Files

```
lib/embeddings.ts                          ← runtime: getEmbedder, embedKeyword
lib/queries.ts                             ← runtime: scoring CTE with threshold + rescale
lib/preference-router.ts                   ← routes keywords to channels (embedding is fallback)

db/schema.sql                              ← meal_embeddings vector(N), HNSW index
db/migrate_v7_bench.sql                    ← bench_* tables
db/migrate_v8_e5small.sql                  ← (TODO) vector(1024)→vector(384) migration

scraper/scripts/embed-meals.ts             ← production embed (incremental)
scraper/scripts/bench-init.ts              ← seed bench_queries
scraper/scripts/bench-sample.ts            ← build stratified meal pools per query
scraper/scripts/bench-label.ts             ← CLI: fetch / commit / list-pending / status
scraper/scripts/bench-embed-all.ts         ← embed corpus with every candidate model
scraper/scripts/bench-rank.ts              ← compute MAP / NDCG / AUROC against labels
scraper/scripts/bench-report.ts            ← render markdown summary
scraper/scripts/bench-threshold.ts         ← sweep τ, find P/R/F1 sweet spot
scraper/scripts/bench-integrity.ts         ← data-quality sanity checks
scraper/scripts/bench-candidates.ts        ← shared model registry

bench/queries.json                         ← 171 query catalogue
bench/prompts/label-meal-batch.md          ← LLM oracle rubric
bench/vectors/*.bin                        ← per-model packed embedding cache
bench/LABELING-INSTRUCTIONS.md             ← handoff doc for external labeling agent
bench/README.md                            ← short operator guide

lib/__tests__/queries-ranked-multiclause.test.ts   ← 37 property-based scoring tests
```

---

## Known gaps

1. **e5-large** doesn't load on the current Node 24 + `onnxruntime-node@1.14.0`
   combo. Marginal improvement over e5-small in published benchmarks;
   not worth a dependency upgrade unless first-iteration results are
   close to a tie.
2. **Polish-specific models** (`sdadas/mmlw-retrieval-e5-large`,
   `ipipan/silver-retriever-*`) aren't in the bench yet — they don't
   have Xenova ONNX exports. Could be exported via `optimum-cli` if
   we want to push beyond multilingual baselines. Polish-finetuned
   models historically beat multilingual ones by 5–15 pp on Polish IR
   benchmarks — worth a future round.
3. **Negation queries** (`bez kurczaka`, `bez mleka`, …) are partially
   labeled. Negation is inverted — meals NOT containing X should
   score high. Embeddings don't natively handle this; the channel
   probably needs a separate `exclude` routing path (see backlog).
4. **Threshold per query family** could be tighter than a global
   constant. Subjective queries (`zdrowe`, `lekkie`) have very
   different distributions than tag queries (`niskie ig`). Single τ
   is fine for v1; per-family τ is a refinement.

---

## TL;DR

**Use e5-small at τ=0.80 with `"passage: "`/`"query: "` prefixes.**

It beats bge-m3 on every metric, every oracle, by 5–10 percentage
points on average — across 4 independent LLM labelers and 6 candidate
models. It's also 6× faster, 4× smaller, and uses 2.7× less storage
per vector. The threshold of 0.80 falls cleanly out of the sweep
across all labelers.

The bench infrastructure is repeatable. When a new candidate model
appears, add it to `bench-candidates.ts`, embed, rank, compare.
Labels stay forever — the cost is amortized.
