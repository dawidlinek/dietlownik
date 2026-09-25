# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

# dietlownik

A personal decision tool for ordering catering diets (meal delivery) in
Poland. It scrapes dietly.pl into Postgres, then ranks the resulting offers
against free-form Polish food preferences — "dużo białka, bez psiankowatych,
kurczak" — and answers _which catering, which diet, which day, at what price_.

One repo, one Postgres database, four components: **scraper**, **ranking
engine**, **dashboard**, **MCP server**.

Reference docs: `API.md` (reverse-engineered dietly mobile API),
`EMBEDDINGS.md` (semantic matching + model bench), `MCP.md` (agent tools),
`db/schema.sql` (data model), `.impeccable.md` (full design brief).

## Toolchain — bun is canonical

CI (`.github/workflows/ci.yml`), `lefthook.yml`, and the `Dockerfile` all run
**bun** against `bun.lock`. A `package-lock.json` also exists, so `npm` works
locally, but the two lockfiles resolve independently and can drift — `npm`
honours the `^` ranges and will pick up newer minors than `bun.lock` pins.

The repo currently lints clean on both oxlint 1.62.x and 1.63.x, so either
runner gives the same answer today. If a future minor disagrees, check
against the pinned version before "fixing" the code:

```bash
npx oxlint@$(grep -oE '"oxlint@[0-9.]+"' bun.lock | head -1 | grep -oE '[0-9.]+') --config .oxlintrc.json
```

## Commands

Written as `bun run`; `npm run` works for all of them with the caveat above.

**Dev / build**

- `bun run dev` · `bun run build` · `bun run start` · `bun run typecheck`
- `bun run check` (oxlint via ultracite) · `bun run fix` (auto-fix)
- `bun run test` · `bun run test:watch`
- `bun run test:integration` — sets `INTEGRATION=1`, hits the live dietly API

`lefthook` runs `check` + `test` pre-commit. Don't bypass with `--no-verify`.

**Database** — order matters, see "Bootstrapping a database" below

- `bun run migrate` — **destructive**: drops `public`, applies `db/schema.sql`
- `bun run migrate:reset` — same thing; `--reset` is an explicit-intent no-op
- `node db/migrate-fresh.js --seed-taxonomy` — also seeds `db/seed/taxonomy.sql`
- `bun run migrate:v11` — event logs → spans, dish content → variants;
  `--verify` re-runs its checks, `--finalize` drops the superseded tables
- `bun run migrate:v12` — `company_city_history` (per-city delivery fee /
  "from" prices over time); additive
- `bun run migrate:v13` — tier-aware leaves, settings/campaign/photo history,
  ingredient-name dictionary
- `bun run migrate:v14` — `scrape_runs.selection_size`, the footer's
  "wycenionych dań"; `bun run stats:selection` recomputes it now
  (every scrape run does it on its own)
- `bun run migrate:v15` — menus are national: drops `menu_items.city_id`
- `bun run migrate:v16` — national scrape: tracked cities, home cities,
  membership lifecycle, price cities, `city_quotes()`
- `bun run bench:migrate` — `bench_*` tables (only if running the model bench)

**Scrapers**

- `bun run scrape` — the national scrape: refresh tracked cities, then every
  catering once from its home city, then price groups (see "City scope")
- `bun run cities:track` — track Poland's 66 county-level cities; `-- <name>…`
  tracks specific ones, `-- --list` shows the set, `-- --untrack <name>`
- `bun run scrape:smoke` — robinfood, no menus (fast sanity check)
- `bun run scrape:menu-smoke` — robinfood with menus
- `bun run scrape:promo-prices` — re-price using known promo codes
- `bun run sync-form-settings` — refresh per-company `formSettings` flags
- `bun run clean-hidden-bodies` — purge meal bodies caterings opted out of
- `bun run check:cities` — city-divergence sampler; see "City scope" below
- `bun run check:prices` — do `city_quotes()` prices match dietly's live
  quotes city by city? Scores the city rule and freshness separately

**Embeddings**

- `bun run embed` — incremental backfill of `variant_embeddings`, most
  recently served variants first. Only needed for past dates: the scrape
  already embeds every variant on a current or upcoming menu

**Model bench** (see `EMBEDDINGS.md`, `bench/README.md`)

- `bench:init` · `bench:sample` · `bench:label` · `bench:embed-all`
- `bench:rank` · `bench:report` · `bench:threshold` · `bench:integrity`

**Cloudflare session** (fallback fetch mode only)

- `bun run cf-session` (parse cURL/HAR) · `bun run cf-session:auto` (headless)

## Bootstrapping a database

`db/schema.sql` is self-sufficient — one command gives you a complete,
correctly-indexed database:

```bash
node db/migrate-fresh.js --seed-taxonomy   # schema + ingredient taxonomy
bun run scrape                             # populate
bun run embed                              # optional: vectors for past dates
```

**`migrate` is destructive**: it drops the `public` schema and recreates it.
`migrate:reset` is the same command; `--reset` is an explicit-intent no-op.

Skip `--seed-taxonomy` and the category channel (`psiankowate`,
`strączkowe`, …) silently matches nothing — it is a PK lookup against
`ingredient_taxonomy`, so an empty table means no hits rather than an error.

The numbered migrations are for **upgrading existing databases**, not for
building new ones:

| Script          | Purpose                                                                             |
| --------------- | ----------------------------------------------------------------------------------- |
| `migrate:v11`   | Event logs → spans, content → variants, one vector per variant. See below           |
| `migrate:v12`   | `company_city_history` — per-city delivery fee and "from" prices as spans           |
| `migrate:v13`   | Tier-aware leaves, more history, ingredient dictionary. See below                   |
| `migrate:v14`   | `scrape_runs.selection_size` (footer number); additive, run `stats:selection` after |
| `migrate:v15`   | Menus are national: drops `menu_items.city_id`. See "City scope"                    |
| `migrate:v16`   | National scrape: tracked cities, home/price cities, `city_quotes()`. "City scope"   |
| `bench:migrate` | `bench_*` tables — only if running the model bench                                  |

Apply them in order; `schema.sql` is already at v16. v15 refuses a database
whose `menu_items` holds more than one city; v16 refuses one without v15. v11 refuses anything
but a v10 database, v13 refuses one without v11 and v12, and v12 is
additive (`IF NOT EXISTS`). The v8–v10 scripts and the older
`db/migrate.js` / `migrate_v2..v6` have been deleted, so a database that
never reached v10 can't take this path — rebuild it with `migrate` and
re-scrape. `bench_*` tables (v7) are deliberately **not** in `schema.sql`.

### Upgrading to v11

`bun run migrate:v11` (`db/migrate_v11_history.js`) runs every step of
`db/migrate_v11_history.sql` in **one transaction**, then read-only
verification checks. Nothing is deleted: the superseded tables are renamed
`legacy_*`. `--verify` re-runs the checks; `--finalize` re-verifies, then
drops `legacy_daily_menu`, `legacy_prices` and `legacy_meal_embeddings`.
`legacy_meals_history` and `legacy_meal_ingredients_snapshots` are kept on
purpose — per-version label/thermo/allergens and the exact write order
can't be rebuilt from the new tables.

What is exact and what is reconstructed:

- **Prices and menu presence are exact.** Every legacy row is covered by a
  span with identical values, observations sum to the legacy row count, no
  span covers a fetch that lacked it, no spans overlap.
- **Per-option variant and macros are reconstructed** from the old write
  order: legacy `daily_menu` stored only `meal_id`, so each fetch is matched
  to the ingredient snapshot current at its `captured_at`. Reviews are
  approximate.
- **Variants rebuilt from snapshots** carry `origin = 'v11-backfill'`; their
  label/thermo/allergens are the dish's last-known values, never recorded
  per version.

Verified on a clone of the live 15 GB database, ~11.5 min: menu 12,813,867
rows → 2,916,211 spans, prices 2,488,394 → 115,070, every legacy ingredient
list survives as a variant (364k). Portion scaling (see "Ranking engine")
moved offers whose default meals sum >15% away from the advertised kcal from
448 to 45 (>30%: 217 → 24), same 1,563 offers on 2026-09-22.

After the upgrade only the ~173k current variants had vectors (carried
over); as of 2026-09-23 ~170k historical variants (past dates only) still
have none. That no longer matters for ranking: the end-of-scrape embed flush
also embeds any variant on a current or upcoming menu that lacks a vector.
`bun run embed` (most-recently-served first) is only needed to analyse past
dates. The embedding channel is silent for a variant without a vector.

### Upgrading to v13

`bun run migrate:v13` (`db/migrate_v13_tiers_history.js`) runs
`db/migrate_v13_tiers_history.sql` in **one transaction**, then checks that
every price and menu span belongs to a catalog leaf, that there is one open
price span per key, and that the `meal_ingredients` view returns every row.

- **Tier-aware leaves** — see "Data model". Existing history stays attached
  to the tier recorded at the time: `menu_items` always stored it,
  `price_history` gets the tier the catalog holds now. The 18 leaves whose
  kept tier had changed are planted inactive so old menu spans keep a valid
  key. After v13 and one catalog pass, active leaves went 14,724 → 17,307.
- **Seeded history**: `company_history` and `campaign_history` start with
  the current values as one observation. Open `menu_items` spans get the
  dish's last-known photo so the next scrape extends them rather than
  splitting every span; closed spans stay `NULL` (unknown).
- **Ingredient dictionary**: 4.67M ingredient rows used 14,182 distinct
  names, now stored once in `ingredient_names`; ~675 MB → ~410 MB.
- Empty-string photos become `NULL` (160k meals had `''`); unknown leaf kcal
  becomes `NULL` instead of 0.

### Running the tests for real

Every DB-backed suite is guarded by `describe.skipIf(!DATABASE_URL)`, so
without a database `bun run test` skips 143 of 258 tests and still exits 0.
`vitest.setup.ts` loads `.env`, so a `DATABASE_URL` there is enough:

```bash
bun run test                               # picks up .env
DATABASE_URL=postgres://... bun run test   # explicit wins; dotenv won't override
```

With a populated database that is 248 passing instead of 115, with 10 skipped
— those 10 are the live-API suite, gated behind `INTEGRATION=1`:

```bash
INTEGRATION=1 bun run test:integration    # hits dietly.pl through the CF bypass
```

If patchright can't launch (its postinstall is often blocked, and it has no
build for some distros), point it at any Chromium you already have:
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome`.

Test dates are **resolved from the data** by
`lib/__tests__/helpers/populated-date.ts`, which picks the busiest available
`menu_date`. Don't reintroduce hardcoded fixture dates — the suite previously
pinned `2026-05-17`, which aged out of the retention window and turned six
passing tests into `expected 0 to be greater than 0` failures that read like
regressions.

`mcp/__tests__/call-tool-roundtrip.test.ts` drives real tools through
`callTool` against a live database. That is the only path where a tool's
`outputSchema` is validated — every other MCP test calls `tool.execute(...)`
directly and cannot catch schema drift. Two shipped bugs hid in that gap.

`scraper/__tests__/spans.test.ts` drives the real span writers
(`upsertMeal`, `upsertVariant`, `recordMenu`, `recordQuote`, `recordSpan`)
against the schema under a throwaway catering `__span_test__`, which it
deletes afterwards — including per-tier pricing of one shared
`diet_calories_id` and the ingredient dictionary. It **writes** to whatever
`DATABASE_URL` points at.

## Architecture

### 1. Scraper (`scraper/`)

`tsx scraper/index.ts` — the national scrape, three passes (design and
evidence in "City scope"):

1. **City refresh** (`scrapers/city-refresh.ts`) for every tracked city not
   refreshed in `CITY_REFRESH_HOURS` (20): one `awarded-and-top` listing
   (which caterings deliver there), then `/city` per catering (delivery fee,
   terms, advertised diet prices). Caterings missing from a complete listing
   are deactivated.
2. **National pass**: each catering once, from its **home city**
   (`companies.home_city_id`, chosen in `scrapers/price-groups.ts`) —
   `catalog` → (`prices`, `menus`) in parallel. `CITY` (default `Wrocław`)
   is the anchor: always tracked, and the preferred home.
3. **Price groups**: each (catering, city) gets a price city — the home city
   when it advertises the same diet prices, else one representative per
   distinct price list — and representatives that aren't home cities are
   quoted too.

Then `diet-tags` and `promotions` once. Ends by flushing queued embeddings via
`scraper/embed-queue.ts` — newly inserted variants plus any variant on a
current or upcoming menu that still lacks a vector. A one-shot run then
closes the shared Chrome (`closeCfBrowser` in `scraper/cf-fetch.ts`) so the
process exits.

`COMPANY=<slug>` scopes a run to one catering at its home city plus its
price groups, skipping the city refresh; it keeps the search-only fields
(from `awarded-and-top`) instead of NULLing them. `SKIP_CITY_REFRESH=1` and
`SKIP_PRICE_GROUPS=1` drop passes 1 and 3. A `/city` response
with `citySearchResult: null` (the catering doesn't deliver to that city) no
longer aborts the catalog.

Cron mode with `SCRAPE_SCHEDULER=1` or `--repeat` (daily 06:00 Warsaw).
Failures do not abort the run; `scraper/scrape-run.ts` logs them to the DB:
`scrape_runs` (one per run, with status), `scrape_stage_results` (one row
per run × company × stage — `catalog`, `prices`, `menus` — with `ok` and a
`fail_count` of per-request failures) and `scrape_errors` (the failures
themselves). This log is what tells "the catering dropped it" apart from
"we failed to scrape that catering that day". Log writes are best-effort: a
failed write is warned about and swallowed.

`scraper/scrapers/reviews.ts` is orphaned — nothing imports it. Company
ratings are captured by `catalog.ts` into `company_ratings_history` instead.

**Shared HTTP client** (`scraper/api.ts`): base URL
`https://aplikacja.dietly.pl`, mandatory `accept-language: pl-PL` and
`company-id: {slug}` on every `/company-card/...` call (the API 400s
without it), a global concurrency semaphore, inter-request gap, and
exponential-backoff retries.

### 2. Ranking engine (`lib/preference-router.ts`, `lib/queries.ts`)

The heart of the project, and the part most likely to be misread as "just
SQL". `getRankedOffersForDay` in `lib/queries.ts` is a ~950-line CTE chain.

Free-form Polish keywords are routed by `routeOne` in
`lib/preference-router.ts`. The first three channels are exact-match and
mutually exclusive; anything matching none of them falls through to _both_
of the last two:

1. **Allergen** — keyword hits a fixed synonym lexicon (15 keys → the 14 EU
   allergens; `nabial` → `mleko`), then matched against the served
   variant's `meal_variants.allergens`
2. **Macro** — grammar like `dużo białka`, `niskie ig`, `mało tłuszczu`;
   resolves to per-100kcal percentile or direct kcal threshold predicates
   on the option's portion (`menu_items`, scaled — see below)
3. **Category** — `ingredient_taxonomy` PK lookup, expanded to member
   patterns and matched against the served variant's `meal_ingredients`.
   Multi-word keys are matched on both spellings, so `owoce morza` finds
   `owoce_morza`
4. **Ingredient** — lexical `word_similarity() >= 0.6` against the served
   variant's `meal_ingredients.name_normalized` and `meals.name_normalized`,
   with Polish stemming (`lib/polish-stem.ts`)
5. **Embedding** — semantic match against the served variant's vector in
   `variant_embeddings`

Every content channel reads `menu_items.variant_id` — exactly what that
option served — never "the dish" or its latest variant. The same dish name
is served in several diets at once with different ingredient lists.

The router emits 4 and 5 together, but **5 is a fallback, not a peer**: if
the ingredient channel fires for a keyword anywhere in the day's candidate
set, the SQL drops the embedding hits for that keyword entirely.

Do not restore the old "`pomidor` wants lexical, `ostre` wants semantic"
split — it is measurably backwards. On the live corpus e5-small ranks
desserts _above_ spicy food for `ostre` (mean cosine 0.784 vs 0.767), while
`word_similarity` finds `papryczka ostra`, `jalapeno` and `ajvar` correctly.
Embedding earns its keep only where lexical has nothing (`koktajl`,
`wegetariańskie`).

Each hit contributes a signed penalty scaled by `weights.prefer` /
`weights.avoid`. Every channel's penalty is capped at **1.0** — allergen,
category and macro are flat 1.0, ingredient is the `word_similarity`, and
embedding is normalised onto `[0, 1]` inside its retained band. The cap is
load-bearing: it stops a semantic near-miss outranking a literal ingredient
match or a hard allergen hit.

The embedding cutoff is **relative, per keyword** — the top
`1 - EMBEDDING_PERCENTILE` slice of the day's candidate meals, floored at
`EMBEDDING_FLOOR` cosine (both in `lib/queries.ts`). An absolute threshold
does not survive this corpus: e5-small compresses every similarity into a
~0.72–0.89 band whose centre moves with query length, so the old fixed 0.80
admitted 2.4% of meals for `grill` and 98.2% for `śniadanie na słodko`. The
current numbers are reasoned starting points, **not** a bench sweep — re-run
`bench:threshold` against this formulation before calling them calibrated.

Macro percentiles (`dużo białka`, `mało tłuszczu`, …) are likewise
**relative to the day's candidates**, not the whole corpus: per-100kcal
ratios come from the fetched portions, kcal from the scaled ones.

**Portions are scaled.** The menus scraper fetches only the lowest-kcal
sibling of each (tier, option) family, so `menu_items` macros are that
portion's. When the ranking fans a canonical menu out to its kcal siblings
it multiplies them by `sibling.calories / canonical.calories`; without this
a 2500 kcal offer reported its 1200 kcal sibling's macros.

**Price is the current quote per series** — the open `price_history` span,
seen within 30 days — not every quote of the last 30 days, which could
surface a price that has since risen.

Vectors must stay in sync with the 384-dim `vector` columns in
`db/schema.sql` and the model in `lib/embeddings.ts`
(`Xenova/multilingual-e5-small`).

e5 requires asymmetric prefixes: `"passage: "` when indexing, `"query: "`
when searching. Dropping either silently drifts vectors out of distribution.

The indexed text is `buildPassage` in `scraper/meal-passage.ts`, shared by
the scrape-time queue and `embed`. Change its output and you must bump
`PASSAGE_VERSION`, or two passage formats end up mixed in one table; `embed`
re-embeds every variant with an older version. There is no HNSW index on
purpose — ranking computes exact cosine over one day's candidates.

`getWeekView` and `getWeeklyPlan` fan out per-day queries and share one
pre-routed `RoutedIntents` so taxonomy and keyword-embedding lookups happen
once per request rather than once per day.

### 3. Dashboard (`app/`, `components/`)

Next.js 16 App Router, React 19, Tailwind 4, Radix, Recharts.

- `/` — the live product: `MatchExperience2`, server-rendered from
  `lib/queries.ts`, two-phase lazy loading, scatter plot + day-by-day list
- `/match` — **mock only**. Renders the older `MatchExperience` against
  `lib/mock-match-data.ts` fixtures. Not wired to Postgres.

Server components query Postgres directly. Four route handlers exist for
client-side incremental fetches — `match-week` (lazy per-day pool),
`price-history`, `variant-meals`, and `mcp`.

### 4. MCP server (`mcp/`, mounted at `app/api/mcp/route.ts`)

Seven tools that mirror the dashboard: `get_context`, `plan`, `get_offer`,
`find_diets`, `quote`, `login`, `send_to_basket`. Nothing places or pays
for an order — `send_to_basket` is the dashboard's "zamów" handoff
(`lib/dietly-basket-send.ts`, shared with `app/api/dietly/basket`). Full
reference in `MCP.md`.

Two invariants:

- **`offer_id` is opaque.** `offer_id` encodes
  `v1:<company>:<diet_calories_id>[:<tier_diet_option_id>]`
  (`mcp/offer.ts`). Tools must never parse or synthesize them. A
  menu-configuration offer's tier (needed since v13, see "Data model")
  comes from `tierIdOfOffer` in that module, not from splitting the id.
- **One `DietlyClient` per MCP session.** The dietly cookie jar is
  per-session, never process-wide — otherwise one user's email could reuse
  another's cached cookies. Sessions live in memory, keyed by
  `mcp-session-id`, 30-minute TTL, dropped on restart.

## Data model

`company → diet → tier → diet_option → diet_calories (leaf) → price_history`

A leaf is **`(company_id, diet_calories_id, tier_id)`** — that triple is the
`diet_calories` primary key and the join key (and FK) for `price_history`
and `menu_items`. `diet_calories_id` alone is unique neither globally
(caterings reuse 1, 2, 3, … as their own ids) nor within a catering:
menu-configuration diets reuse one id across their tiers (meal-count
packages at different prices). Verified 2026-09-23: 1,833 ids at 64 of 165
caterings, always the same diet and option, never twice in one tier.

Before v13 the key was `(company_id, diet_calories_id)`, which kept one tier
per id and silently dropped the rest: 119 of 278 menu-config tiers had no
leaves and were never priced or menu-scraped — e.g. activbox id 657 is
Premium 88.99 / Comfort 87.99 / Basic 78.99 zł, and Basic was the lost one.
**Any join on `diet_calories_id` must also match `company_id` and
`tier_id`**, or it fans one price out across every package. Ranking joins
canonical/priced/meta on the tier; `getPriceHistory` and the
`price-history` route take an optional `tier_id` for the same reason.

Ready (non-menu-config) diets store their real options ("3/5/6 posiłków")
under tier 0. Option 0 is a placeholder kept only for ids known solely from
`/city`, whose `calories` is `NULL` (unknown, not 0).

Catalog tables are slowly-changing dimensions: `fingerprint`,
`first_seen_at`, `last_seen_at`, `is_active`. A scrape that doesn't see an
entity flips `is_active` false rather than deleting; reappearance flips it
back. Filter them on `is_active`; there are no `current_*` views for them.
`diet_discounts.tier_id` separates tier discount ladders from the diet's own
(`0`); `tiers` carry `description` and `min_price` (snapshotted too).
`companies.awarded` comes from `/city` — before v13 it was always false.

**Dishes: identity vs content.**

- `meals` is identity only, keyed by `(company_id, name)`.
- `meal_variants` holds content, content-addressed by the SQL function
  `meal_content_sha(label, thermo, allergens, ingredients)`. Exact, not
  normalised: ingredient spelling and order are data. Immutable; a return
  to an earlier content reuses its row.
- `meal_ingredients` is per variant. Since v13 it is a **view** over
  `variant_ingredients` + `ingredient_names` (4.67M rows used only 14,182
  distinct names; the trigram GIN index lives on `ingredient_names`). Read
  through the view; write only through `upsertVariant` in
  `scraper/scrapers/menus.ts`. `variant_ingredients.exclusion_ids` map
  ingredients to `dietary_exclusions`, dietly's "wyklucz" vocabulary, and
  `meal_variants.allergens_detail` keeps each allergen's id and the
  catering's own wording.
- `menu_items.variant_id` records exactly what each option served.
  `meal_latest_variant` gives "the dish as it looks now" for scripts; ranking
  never uses it.

The split is not theoretical: the same dish name is served simultaneously in
several diets with different ingredient lists — 22k dishes differ even after
normalising case and order. One content per dish meant every scrape
overwrote it back and forth.

Portion numbers (kcal, protein, …) and reviews live on `menu_items`, per
option, because the same dish is served at different kcal in different
diets. They are the fetched lowest-kcal sibling's portion; see "Portions
are scaled" above.

`campaigns` is `UNIQUE NULLS NOT DISTINCT (company_id, code)`: global
campaigns carry `company_id = NULL`, and a plain `UNIQUE` let every scrape
insert another copy of them. `valid_from` / `valid_to` are the exact UTC
validity; `separate` means the code must be typed at checkout.

`API.md` §10 ("What we store, and what we drop") is the field-by-field
coverage of dietly's responses — check it before adding a column.

### History model — spans, not event logs

Span tables store one row per unbroken run of identical observations, with
`first_seen_at`, `last_seen_at`, `observations` and `closed_at` (`NULL` =
current). `current_menu_items` and `current_prices` are just
`closed_at IS NULL`; history queries read the full table. The span tables:

| table                    | one span per …                 | what                                             |
| ------------------------ | ------------------------------ | ------------------------------------------------ |
| `menu_items`             | option (see key below)         | dish, variant, portion, reviews, photo           |
| `price_history`          | leaf × city × days × promo set | quoted price                                     |
| `company_city_history`   | company × city                 | advertised fee, "from" prices, switches, windows |
| `diet_advertised_prices` | company × city × diet          | `/city` list / promo price                       |
| `company_history`        | company                        | settings, contact, `params`, review %            |
| `campaign_history`       | company × code                 | promo terms                                      |
| `company_side_orders`    | company × name                 | paid extras and their price                      |

`menu_items.image_url` is the photo that option showed; dietly's `''` is
stored as `NULL`.

- An identical re-observation within `SPAN_GAP` (36 h, `scraper/spans.ts`)
  extends the span.
- A value change, an option missing from a **successful** menu fetch, or a
  silence longer than 36 h closes it and opens a new one. The real end lies
  in `(last_seen_at, closed_at]`.
- An empty menu response closes nothing — it says nothing about removals.
- At most one open span per key, enforced by a partial unique index.

**Delivery fee** has two sources. The fee actually charged is
`price_history.total_delivery_cost`, per quote, and it is **included** in
`total_cost` (food-only = `total_cost - total_delivery_cost`). The fee a
catering advertises per city is `company_city_history.delivery_fee`, next to
its "from" prices and ordering switches (history from v12 on;
`order_possible_on/to` stay current-only in `company_cities` because they
roll forward daily).

A menu option's key is `(company, diet_calories_id, tier, date,
api_meal_slot_id)` — no city since v15. `api_meal_slot_id` is dietly's `dietCaloriesMealId`:
unique within one response and stable across scrapes of the same date, so
it identifies the option — but not the dish, which changes behind it in ~2%
of cases (a real menu swap, which closes the span).

**Never `INSERT` into a span table directly.** Go through `recordMenu`
(`scraper/scrapers/menus.ts`) or the generic `recordSpan`
(`scraper/spans.ts`, used by `recordQuote` and every other span table).
Anything else either breaks the one-open-span invariant or quietly turns
the table back into an event log.

## City scope — menus are national, prices are not

Until v15, `menu_items` and `price_history` both carried `city_id`, so the
same dish row was written once per city. That is what makes national
coverage expensive,
and "national" is bigger than it looks: dietly's city ids are GUS TERYT
SIMC codes (Wrocław `986283` = SIMC 0986283), so any of Poland's ~100k
localities is addressable, and each catering delivers to thousands of them —
median ~6,400, up to 48,499 (`companies.delivery_cities_count`). A locality
sees 42–152 caterings; 172 distinct caterings appeared across 220 sampled
localities, 19 of which don't deliver to Wrocław at all. One city already
costs ~3 h per run. Storage stopped scaling with scrape count in v11 (spans instead of an
event log): four months of Wrocław took ~15 GB as event logs and ~2.5 GB as
spans, plus the kept `legacy_*` history tables.

`bun run check:cities` measures whether that per-city duplication buys
anything. It samples (company, city) pairs — cities spread across
voivodeships, companies biased towards caterings that are _not_ listed
everywhere — fixes a reference city, and diffs catalog tree, list price,
quoted price and menu against it. Delivery fee/windows are reported apart:
those are per-city by design.

Measured 2026-09-22. The largest sweep covered all 16 voivodeship capitals
plus 14 villages, 126 caterings, 630 comparison pairs (6,867 requests, ~37
min); the three smaller sweeps before it agree:

| dimension                  | pairs differing | what it means                          |
| -------------------------- | --------------- | -------------------------------------- |
| `catalog` (diet tree)      | 0/630           | identical everywhere                   |
| `menu_lineup`, `menu_body` | 0/435 each      | same dishes, kcal, macros, ingredients |
| `list_price`               | 15/630          | **real** — 7 of 126 caterings          |
| `quote_diet`               | 8/630           | **real** — same caterings              |

So `city_id` was dead weight on `menu_items` — in 435 menu comparisons no
catering ever cooked differently for a different city — and v15 drops it:
menus are stored once per catering, and a city sees the caterings its
`company_cities` rows list. It is **load-bearing on `price_history`**, which
keeps it. About 5% of caterings price by city, and the gaps are
real money: `ligasmaku` 76 zł in Wrocław vs 82 zł in Kraków,
`cateringmistrza` 79 zł vs 69 zł, `timcatering` 67.99 zł vs 65.99 zł.

Mapping those 7 caterings across all 30 cities shows it is **not** a clean
zone model. `timcatering` and `tytkafit` do have exactly two price
signatures, but `ligasmaku` has five: each diet is priced per city
independently (Opole has diet 1 at the high price and diet 14 at the low
one; Kielce the reverse). And the divergent cities are not one region —
`ligasmaku`'s high-price group is Białystok, Kraków, Katowice, Lublin,
Gdańsk, Bydgoszcz. So divergence has to be stored per (company, city, diet),
not per zone. Once a catering prices by city, it usually does so in most
cities it serves. Comparing only against one reference city undercounts it.

Availability varies more than price. Most places get 137–153 caterings, but
some villages get 46–58, so `company_cities` membership really is per-city
data.

Quoting only the first leaf of the first diet misses per-diet pricing, so
the sampler quotes one leaf per diet before taking a second from any diet.

Two traps when extending this:

- `cart.totalCostToPay` **includes the delivery fee**. Diffing it reports a
  5 zł courier difference as a price divergence on caterings whose food
  price is identical. Compare `perDayDietCost` / `totalCostWithoutDiscounts`;
  the sampler keeps `quote_total` as a separate, non-content dimension.
- `/api/dietly-shop/open/supported-cities` looks like a national city list
  and is not: 1,134 of its 1,135 ids are in Mazowieckie (it is the
  Warsaw-area Dietly Shop). Don't seed anything national from it. The
  sampler uses it only as a pool of villages and seeds geographic spread
  from the 16 voivodeship capitals, resolved by name.

Reports land in `reports/` (gitignored). Exit code 1 means content
divergence was found, so this can run as a monitor.

### The national scrape (v16)

What the findings above turn into (`scraper/index.ts`,
`scrapers/city-refresh.ts`, `scrapers/price-groups.ts`):

- **Tracked cities** (`cities.tracked`) are the ones kept fresh.
  `bun run cities:track` adds Poland's 66 county-level cities; the anchor
  (`CITY`) is always tracked. Any other locality has no data until tracked.
- **Menus and catalogs** are scraped once per catering, from its home city.
  A catering that doesn't deliver to the anchor is homed at its lowest
  tracked city — that is how the 25 caterings Wrocław never lists get in.
- **Prices**: read them for a city through `city_quotes(city_id)`, never
  `price_history` directly. A city that advertises no diet prices borrows
  the home city's quotes — some caterings (maczfit, diet4u, …) never
  publish advertised prices at all, yet quote normally. It returns the city's price city's quotes with
  the city's own advertised delivery fee swapped in. When the city is its
  own price city the quote comes back exactly as dietly gave it.
- **Cost**, measured on the first full run (2026-09-24, 66 cities, 177
  caterings, 74,167 requests, 0 Cloudflare challenges):

  | pass            | time     | requests                                      |
  | --------------- | -------- | --------------------------------------------- |
  | city refresh    | 48.8 min | 9,833 `/city` + 66 listings (44 s per city)   |
  | national pass   | 4 h 36 m | 42,140 quotes, 21,940 menus, 176 catalogs     |
  | price groups    | 48 min   | 45 quote sets (37 caterings differ somewhere) |
  | embed (one-off) | 45 min   | 38,586 variants from the 25 new caterings     |

  6 h 57 min end to end; later runs skip most of the embedding. Memberships:
  9,657, of which 9,266 (96%) borrow the home city's quotes. The database
  grew 313 MB (+3%) for 65 more cities. Ranking a city's full day is flat
  across cities (14.8–15.5 s) and `city_quotes()` adds 1–3% over reading
  `price_history` directly.

**Scope decision (2026-09-24): 66 cities, not every locality.** dietly
serves ~49k localities; Kuchnia Vikinga alone reaches 48,499, and over half
of all localities are served by exactly one catering. A per-catering
delivery-area endpoint exists (API.md §1, "Catering delivery areas") that
would map who delivers where, with the delivery fee, for all of them in
~16.6k requests. It isn't used because exact per-locality _prices_ would
still need ~1M `/city` calls, and the localities it adds are mostly
single-catering villages. It is the way in if coverage ever needs to grow.

How the rules are guarded:

- The price city is chosen from the **advertised per-diet** prices plus the
  city's **"from" prices** (`lowest_price_standard` /
  `lowest_price_menu_config`). Per-diet prices caught 7 of 7 quote
  differences; the "from" prices add the tier level, so a catering pricing
  one meal-count package per city can't hide behind an unchanged diet
  price.
- The delivery fee is swapped by the difference between the two cities'
  **advertised** fees. Advertised and quoted fees disagree outright for ~10
  caterings (listed 8 zł, quoted 0; or 0 on some diets and 5 on others),
  but the swap only needs the _difference_ between cities to be right.
  `bun run check:prices` measures exactly that — live(city) against
  live(price city) + delta — separately from staleness. Against a day-old
  clone, every one of 96 samples across those caterings came back identical
  in all three cities: the misses were stale quotes, the city rule was
  right.
- Quotes left in a city that is no longer anyone's price city (a group
  dissolved, a home moved) are closed at the end of each run
  (`closeUnquotedPrices`), so "open" still means "current".

## Cloudflare bypass (non-obvious, load-bearing)

dietly.pl sits behind Cloudflare Bot Management. Toggled by
`DIETLY_USE_PATCHRIGHT` (default `1`):

- **Patchright mode** (default): every request runs inside
  `page.evaluate(() => fetch(...))` on a persistent Chrome page
  (`scraper/cf-fetch.ts`, `scraper/cf-shared.ts`). Chrome's real TLS/HTTP-2
  fingerprint is what passes CF. Profile persists at
  `~/.cache/dietlownik-cf-profile` (override with `CF_USER_DATA_DIR`);
  delete it to reset. `CF_HEADLESS=0` to watch it work.
- **Fallback mode** (`DIETLY_USE_PATCHRIGHT=0`): plain `fetch` plus a
  manually captured cookie in `.cf-session.json`. Brittle under concurrency.

Don't "simplify" this to plain `fetch`. A long run of commits exists purely
to make it work. Keep concurrency low and intervals generous here.

## Conventions

- **Path alias**: `@/*` → repo root (`tsconfig.json`)
- **ESM** (`"type": "module"`). Lazy relative imports in the scraper carry
  the `.js` extension: `import("./scrapers/menus.js")`
- **Polish data is native.** Cities, diets, meals, ingredients are stored and
  displayed in Polish. Never translate in queries or UI
- **Env vars**: `dotenv`, see `.env.example` — it lists every variable the
  code reads. Only `DATABASE_URL` is required
- **Docker**: one multi-stage image. Default `CMD` is `node start.js`, which
  runs the Next standalone server **and** the daily scraper scheduler
  together. Override `CMD` for one-shot scraper or migration jobs

## Design brief

Full version in `.impeccable.md` — read it before any UI work. The short
form:

**Cozy, honest, sharp.** A kitchen counter at 9pm, not a price-comparison
portal. Warm food-derived palette on a cream/oat base, light theme only;
never pure white. Distinctive display face, no Inter/Roboto/system defaults.

1. **Numbers are the design.** Typography, weight, alignment do the work. A
   chart must show something the table can't.
2. **Warm, not cute.** No mascots, no emoji as UI, no rounded-everything.
3. **Honest math, visible promos.** Show list price → promo → final per-day
   cost. Never hide the stack, never dramatize an expiry.
4. **Density with rhythm.** Tight inside a row, generous between sections.
   No identical-card grids.
5. **Respect the expert.** Polish domain terms as-is (kcal, dieta, tier,
   pakiet). No tooltips explaining the obvious.

**Anti-reference**: the Polish e-commerce default (Allegro / Ceneo /
Pyszne.pl) — banner stacks, competing CTAs, saturated reds, "promocja!"
stickers. Also: generic SaaS indigo, AI-cyberpunk dark/cyan/glow, and
photography-as-decoration food-app energy.
