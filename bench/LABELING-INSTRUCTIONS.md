# Embedding-bench labeling — instructions for an external agent

Self-contained instructions for an agent (OpenCode, Cursor, Aider, etc.)
to finish the remaining meal-labeling work for the embedding benchmark.

---

## Pick your model

Available on OpenCode Zen, ranked best price/quality for **Polish catering
food labeling** (~300 batches × 25 meals = ~7,500 labels to produce):

### Best balance of speed, quality, and cost — pick one of these:

| #   | Model              | Why                                                                                                                            |
| --- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| 🥇  | **Gemini 3 Flash** | Fast, cheap, native multilingual including Polish. Excellent JSON-instruction following. Best default pick.                    |
| 2   | **GPT-5.4 Mini**   | OpenAI's instruction-following is top-tier; cheap and fast; handles Polish food vocab well. Solid alternative to Gemini Flash. |

### If you want maximum quality (you have credits):

| #   | Model                      | Why                                                                                                                                                                              |
| --- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3   | **Gemini 3.1 Pro Preview** | Top-tier reasoning + multilingual; will give the most nuanced scores on adversarial/clinical queries. ~3× the cost of Flash.                                                     |
| 4   | **GPT-5.5**                | Equivalent quality, OpenAI side. Same magnitude cost.                                                                                                                            |
| 5   | **Claude Sonnet 4.6**      | Equivalent to what you already have from earlier Claude runs — useful only if you want a _third_ Claude oracle for cross-validation. Same family bias as existing labels though. |

### Worth a smoke-test on a single batch (free options):

| #   | Model                     | Why                                                                                                      |
| --- | ------------------------- | -------------------------------------------------------------------------------------------------------- |
| 6   | **Ring 2.6 1T Free**      | 1T-param model that's free. Polish quality unknown — try one batch, eyeball the labels, abandon if weak. |
| 7   | **Nemotron 3 Super Free** | Nvidia's free tier. Same advice — smoke-test first.                                                      |
| 8   | **MiniMax M2.5 Free**     | Free, less proven on Polish food. Last resort if everything else costs too much.                         |

### Skip these for this task:

- **GPT-5.3 Codex / Codex Spark** — tuned for code generation; instruction-following on natural-language scoring rubrics is not their strength.
- **Kimi K2.6** — uses extended thinking, slower per batch with no quality win on this task.
- **Claude Opus 4.7** — overkill cost; you already have Opus labels from the original Claude run.
- **GLM-5.1, Qwen 3.5/3.6 Plus, MiniMax M2.7** — viable but Gemini Flash and GPT-5.4 Mini are both cheaper, faster, and better-proven on Polish for this style of task.

### My pick if you ask me to choose one

**Gemini 3 Flash.** Set `BENCH_LABELER_MODEL=gemini-3-flash` and go. If the first ~10 batches look weak when you spot-check them, switch to **Gemini 3.1 Pro Preview** for the rest.

### Cost expectation

Even at premium-tier prices the entire queue should land under a few dollars
total — you have "quite enough credits" so this isn't the binding constraint.

---

## Working setup

```text
working dir : C:\Users\dawid\Desktop\Inne\dietlownik
db          : Postgres (DATABASE_URL read from .env)
cli         : npm run bench:label -- <subcommand>
rubric      : bench/prompts/label-meal-batch.md (read once before labeling)
```

Important: **set the labeler-model tag** before you start, so the labels
you produce are stored with your model's name and stay separate from the
existing Claude labels.

```bash
# Bash / Linux / Git Bash
export BENCH_LABELER_MODEL=gemini-3-flash
```

```powershell
# PowerShell on Windows
$env:BENCH_LABELER_MODEL = "gemini-3-flash"
```

If you see Polish character corruption from psql, also set
`PGCLIENTENCODING=UTF8`.

---

## One-time cleanup (reset stuck jobs from previous session)

```bash
PGCLIENTENCODING=UTF8 psql "$(grep -E '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"'\''\r')" \
  -c "UPDATE bench_label_jobs
        SET status='pending', started_at=NULL, labeler_model=NULL
        WHERE status='in_progress';"
```

Then sanity-check the state — you should see only `pending` and `done`:

```bash
PGCLIENTENCODING=UTF8 psql "$DATABASE_URL" \
  -c "SELECT status, COUNT(*) FROM bench_label_jobs GROUP BY status;"
```

---

## The labeling loop

Repeat until `list-pending` returns `[]`. **Run in parallel** if your runner
supports parallel subagents (~20 in flight is a good wave size); sequential
works too but takes hours.

### Per-job procedure

```bash
JOB_ID=<from list-pending>

# 1. Fetch the batch — the LAST line of stdout is one JSON object
npm run bench:label -- fetch $JOB_ID 2>/dev/null | tail -1 > /tmp/bench-$JOB_ID-fetch.json
```

The file contains:

```jsonc
{
  "job_id": 1234,
  "query": "kurczak",                  // the keyword to score against
  "query_family": "ingredient",        // see family-specific rules below
  "query_notes": null,                 // optional hint
  "prompt": "# Labeling task\n...",    // full Markdown rubric (read once is enough)
  "payload": {
    "query": "kurczak",
    "query_family": "ingredient",
    "query_notes": null,
    "meals": [
      {
        "meal_id": 12345,
        "name": "Sałatka z grillowanym kurczakiem",
        "label": "Lunch",
        "ingredients": "kurczak, awokado, rukola, ...",
        "allergens": ["seler"],
        "kcal": 480, "protein_g": 38, "fat_g": 22, "carbs_g": 18,
        "fiber_g": 9, "sugar_g": 3, "salt_g": 1.1
      },
      ...
    ]
  }
}
```

**2. Score every meal 0–10** per the rubric. Output JSON:

```jsonc
{
  "labels": [
    {
      "meal_id": 12345,
      "score": 8.5,
      "reason": "lean protein + greens + low sugar",
    },
    {
      "meal_id": 12346,
      "score": 2.0,
      "reason": "pasta carbonara — not 'zdrowe'",
    },
  ],
}
```

- Every meal from `payload.meals` appears **exactly once**.
- `score`: float `[0, 10]`, one decimal place fine.
- `reason`: one short sentence. Used for human spot-checks later.
- **No markdown fences.** No commentary outside the JSON object.

Write it to `/tmp/bench-$JOB_ID.json`.

**3. Commit:**

```bash
npm run bench:label -- commit $JOB_ID --file /tmp/bench-$JOB_ID.json
```

Expected output: `{"job_id":1234,"written":25,"status":"done","labeler":"gemini-3-flash"}`

**4. Discover the next job:**

```bash
npm run bench:label -- list-pending --limit 1
```

Empty array → you're done.

---

## Scoring rubric (summary)

The full rubric is in `bench/prompts/label-meal-batch.md` and arrives
inside every fetch response. Key special-case rules:

| Family                                                         | Rule                                                                                                                                                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `negation` (`bez kurczaka`, `bez cebuli`)                      | **Inverted scale.** 10 = meal does NOT contain X. 0 = meal contains X.                                                                                                                                              |
| `typo` (`kuczak`, `borkuł`, `lososs`)                          | Treat as the intended word and score against that intent.                                                                                                                                                           |
| `inflection` (`kurczakiem`, `z kurczakiem`)                    | Treat as the base form (`kurczak`).                                                                                                                                                                                 |
| `adversarial` (`kurka`, `ser`, `ostry`, `serce`, `biały`)      | Polysemy — use surrounding ingredients to disambiguate per meal. A `kurka` meal with chicken ingredients scores high for chicken-diminutive reading; a meal with chanterelles scores high for the mushroom reading. |
| `clinical` (`na łuszczycy`, `przeciwzapalne`, `dla cukrzyków`) | Apply nutritional knowledge. Anti-inflammatory: fatty fish, leafy greens, berries (HIGH); nightshades, refined sugar (LOW). Diabetic: low-GI carbs, no added sugar (HIGH); sweet sauces, white flour (LOW).         |
| `macro` (`dużo białka`, `mało cukru`)                          | **Use the provided macros directly.** >25g protein per meal = high protein. <5g sugar = low sugar. Don't guess — read the kcal/protein/fat/sugar fields.                                                            |

**General scoring scale:**

| Score | Meaning                                            |
| ----: | -------------------------------------------------- |
|    10 | Textbook match. The keyword _defines_ this meal.   |
|   8–9 | Strong match. Keyword is a primary attribute.      |
|   6–7 | Partial / probable match. Inference one step away. |
|   4–5 | Tangential. User wouldn't be satisfied.            |
|   2–3 | Mostly unrelated. Incidental overlap.              |
|   0–1 | Unrelated.                                         |

Don't compress toward the middle. If a batch is mostly distractors, scores
of 0–1 are correct. If it's mostly relevant, scores of 8–10 are correct.

---

## Throughput notes

- **Per-batch time** at ~25 meals: a few seconds to ~30 sec depending on
  model and parallelism.
- **Parallel waves of 20 subagents** finish ~300 batches in ~20–30 min wall.
- **Sequential** is fine if your runner doesn't parallelize — expect ~2 hr.

If you hit a rate limit, just keep retrying — `bench:label commit` is
idempotent (UPSERT on `(query_id, meal_id, labeler_model)`).

---

## When done

Stop. Don't run `bench:rank` or `bench:report`. The owner will run those
once they review.

Confirm completion with:

```bash
PGCLIENTENCODING=UTF8 psql "$DATABASE_URL" \
  -c "SELECT status, COUNT(*) FROM bench_label_jobs GROUP BY status;"
# should show 0 pending, 0 in_progress, all done

PGCLIENTENCODING=UTF8 psql "$DATABASE_URL" \
  -c "SELECT labeler_model, COUNT(*) FROM bench_labels GROUP BY labeler_model;"
# should show your model's tag (gemini-3-flash) alongside existing claude-opus-4-7
# and claude-sonnet-4-5 entries.
```

Report back:

- Number of labels you wrote
- Any batches that failed and why (so they can be retried)
- Any rubric ambiguities or odd queries you flagged for review

That's it.
