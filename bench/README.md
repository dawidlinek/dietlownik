# Embedding benchmark — operator notes

A ranking-quality eval for picking an embedding model for the `/match`
scoring pipeline. Replaces the old 123-pair classification benchmark with
something that actually measures what we care about: _given a Polish
preference keyword the user typed, how well does each model rank the meals?_

Labels come from Sonnet 4.5 acting as an oracle (no API key required — runs
in parallel inside a Claude Code session via subagents).

## Files

| Path                                 | Purpose                                                                                                                    |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `bench/queries.json`                 | The ~100 query seeds. Edit to add/remove queries.                                                                          |
| `bench/prompts/label-meal-batch.md`  | Rubric handed to each labeling subagent.                                                                                   |
| `db/migrate_v7_bench.sql` + `.js`    | Tables: `bench_queries`, `bench_label_jobs`, `bench_label_job_items`, `bench_labels`, `bench_runs`, `bench_run_per_query`. |
| `scraper/scripts/bench-init.ts`      | Seed `bench_queries` from JSON. Idempotent.                                                                                |
| `scraper/scripts/bench-sample.ts`    | Build per-query stratified meal pools and emit `bench_label_jobs`.                                                         |
| `scraper/scripts/bench-label.ts`     | CLI driving the labeler loop (list-pending / fetch / commit / reset / status).                                             |
| `scraper/scripts/bench-embed-all.ts` | For each candidate model, embed all meals to a packed `.bin` cache.                                                        |
| `scraper/scripts/bench-rank.ts`      | Score each (model × query) — MAP / NDCG@10 / AUROC / Recall@K.                                                             |
| `scraper/scripts/bench-report.ts`    | Render comparison markdown.                                                                                                |
| `bench/vectors/<model>.bin`          | Cached embeddings, packed binary. Gitignored.                                                                              |

## End-to-end run (post-scrape)

The benchmark mirrors production: **a single (city, day) slice**. By default
the city is Wrocław (`986283`) and the day is auto-picked as the busiest day
in `daily_menu`. Override with `BENCH_CITY=...` and `BENCH_DAY=YYYY-MM-DD`.

```bash
# 1. Migration (once)
npm run bench:migrate

# 2. Seed the query catalogue
npm run bench:init

# 3. Sample meals per query, restricted to the (city, day) slice
npm run bench:sample
# → uses default city=986283 (Wrocław), day=busiest

# 4. Run the labeler loop — see "Labeling" below

# 5. Embed all meals with every candidate model
npm run bench:embed-all         # writes bench/vectors/*.bin

# 6. Compute metrics restricted to the SAME (city, day) slice you sampled
npm run bench:rank

# 7. Render report
npm run bench:report > bench/report.md
```

**Important:** `bench:sample` and `bench:rank` must use the SAME `BENCH_CITY`

- `BENCH_DAY`. Otherwise the labels won't intersect the slice and rank will
  abort with "no labeled meals are in the slice."

## Labeling — Claude Code session drives subagents

Subagents are dispatchable only from a Claude Code session (via the `Agent`
tool). The `bench:label` CLI is the contract between the session and the DB.

A correct loop, from inside the session:

```text
1. npm run bench:label -- list-pending --limit 50
   → JSON array of pending jobs

2. For each batch of e.g. 20 jobs, spawn 20 subagents in parallel. Each
   subagent does:

     a. cmd: npm run bench:label -- fetch <job_id>
        → stdout is JSON with { prompt, payload }
     b. apply `prompt` to `payload.meals`, produce {labels:[...]}
     c. cmd: npm run bench:label -- commit <job_id> --file labels.json
        → writes labels to DB and marks job done

3. Repeat with the next 50 pending until list-pending is empty.

4. npm run bench:label -- status
   → final sanity counts
```

Each subagent must be instructed to:

- Read the prompt verbatim from the fetch output.
- Apply it to every meal in `payload.meals`.
- Write the JSON to a temp file rather than passing inline (CLI shell quoting
  of multi-line JSON gets ugly).
- Exit cleanly. Failures don't write — `--reset <job_id>` re-queues a job.

Reasonable per-subagent spec for the dispatcher:

> _"You are a labeler. Run `npm run bench:label -- fetch <JOB_ID>` to get
> the prompt and payload, label every meal per the prompt, write a single
> JSON file `/tmp/bench-<JOB_ID>.json` with the result, then run
> `npm run bench:label -- commit <JOB_ID> --file /tmp/bench-<JOB_ID>.json`.
> Report 'done' on success, 'failed: <reason>' on error."_

### Throughput estimate

- ~10k labels total (100 queries × 100 meals)
- 30 meals per batch → ~333 batches
- 20 subagents in flight, each takes ~45s end-to-end
- Total: ~12–15 minutes of wall time

If Sonnet rate-limits surface, drop concurrency to 10 — total goes to ~25 min.

### Cost

Sonnet 4.5 subagents bill against the Claude Code session, not the API.
Effectively free for a personal-account user; check usage in Claude settings
if running this many times in a day.

## Candidate models in scope

The default list (in `bench-embed-all.ts` and `bench-rank.ts`):

- `bge-m3`, `e5-small/base/large`, `minilm-multi`, `mpnet-multi`, `labse`

To add Polish-specific models (`sdadas/mmlw-retrieval-e5-large` etc.):

1. Generate the ONNX export with `optimum-cli export onnx --model
sdadas/mmlw-retrieval-e5-large --task feature-extraction
./onnx-models/mmlw-e5-large`.
2. Either upload to a personal HF repo and reference it as
   `your-user/mmlw-retrieval-e5-large-onnx`, OR load from local path by
   teaching `@xenova/transformers` to look in `./onnx-models/` (set
   `env.localModelPath`).
3. Add an entry to `CANDIDATES` in `bench-embed-all.ts` AND `ALL_CANDIDATES`
   in `bench-rank.ts` — keep them in sync.

## Tuning knobs

| Env var                    | Default             | What it does                                               |
| -------------------------- | ------------------- | ---------------------------------------------------------- |
| `BENCH_POOL_SIZE`          | 100                 | Meals per query (split across batches)                     |
| `BENCH_BATCH_SIZE`         | 30                  | Meals per subagent batch                                   |
| `BENCH_MODELS`             | all cached          | Comma-separated list to subset which models embed/rank     |
| `BENCH_LABELER_MODEL`      | `claude-sonnet-4-5` | Stored in `bench_labels.labeler_model` for re-labelability |
| `BENCH_POSITIVE_THRESHOLD` | 7                   | LLM score ≥ this counts as "relevant" for recall/AP        |
| `BENCH_RESET`              | —                   | `=1` to wipe and rebuild `bench_label_jobs`                |

## Re-runs and re-labeling

`bench_labels` is keyed by `(query_id, meal_id, labeler_model)`. To re-label
with a stronger model (e.g. Opus) without losing the Sonnet labels:

```bash
BENCH_LABELER_MODEL=claude-opus-4-1 npm run bench:sample     # new jobs
# … run the labeler loop again under that name …
BENCH_LABELER=claude-opus-4-1 npm run bench:rank             # eval against Opus labels
```

Both label sets live side-by-side. Compare per-query MAP under each labeler
to spot queries where weaker / stronger models disagree on what counts.
