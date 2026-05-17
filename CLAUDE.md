# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# dietlownik

Personal scraper + database for tracking dietly.pl meal-delivery (catering
diet) prices, promos, and menus over time. Node.js + TypeScript scraper into
Postgres. See `API.md` for the reverse-engineered dietly mobile API and
`db/schema.sql` for the data model.

## Design Context

### Users

A single user — the project owner — using this as a personal tool to make
better meal-delivery (catering diet) ordering decisions in Poland. They scrape
dietly.pl into Postgres and want a frontend that turns that warehouse into
fast, unambiguous answers: _which diet, which company, which city, at what
price, with what promo, right now_. They already know the domain (Polish
catering, kcal tiers, promo stacking), so the interface should respect that
expertise instead of teaching the basics.

The job-to-be-done: open the dashboard, pick a city + kcal target, see the
current best per-day prices across companies sorted by value, notice anything
that changed since last time, and decide what to order — in well under a
minute.

### Brand Personality

**Cozy, honest, sharp.**

- _Cozy_: warm, food-forward palette and typography. The interface should feel
  like a kitchen counter at 9pm, not a price-comparison portal.
- _Honest_: no marketing chrome, no urgency badges, no "best deal!" stickers.
  Numbers speak for themselves. Promo math is shown, not hidden.
- _Sharp_: dense, confident data presentation. This is a tool for someone who
  already knows what they're looking at — not a tutorial.

The voice is deadpan and competent. Think "someone smart cooked this up for
themselves" rather than "consumer app polished for retention."

Emotionally the interface should produce _quiet satisfaction_ — the feeling
of a well-organized pantry where you can find what you need.

### Aesthetic Direction

Warm / food-forward, light theme only.

- **Palette**: tinted neutrals on a cream/oat base, never pure white. One
  honest food-derived accent (paprika, terracotta, olive, or burnt amber —
  pick one and commit). Tint the grays toward the accent hue for cohesion.
- **Typography**: a distinctive serif or warm humanist sans for display, paired
  with a refined neutral body face. Avoid Inter, Roboto, system defaults.
  Avoid mono as decoration — only use it where tabular alignment genuinely
  matters (price tables).
- **Layout**: generous but rhythmic — vary spacing rather than padding
  everything equally. Left-aligned, asymmetric where it earns the emphasis.
  Tables and number-grids are the hero, not cards.
- **Detail**: hairline rules over heavy borders, typography over chrome,
  numerals styled with care (tabular figures, considered weights for deltas
  and currency).

**Anti-reference (avoid at all costs)**: the Polish e-commerce default —
Allegro / Ceneo / Pyszne.pl aesthetic. Cluttered tables, banner stacks,
multiple competing CTAs, saturated reds, urgency badges, "promocja!" stickers.
Also avoid: generic SaaS indigo, AI-cyberpunk dark/cyan/glow, and
photography-as-decoration food-app energy.

### Design Principles

1. **Numbers are the design.** Per-day prices, deltas, kcal — typography,
   weight, and alignment do the work. No decorative charts, no sparklines as
   garnish. Charts must convey something the table can't.

2. **Warm, not cute.** Palette is food-derived (cream, paprika, olive, burnt
   amber); shapes are restrained. No cartoon mascots, no rounded-everything,
   no emoji as UI. The warmth comes from color and type, not whimsy.

3. **Honest math, visible promos.** Show the path from list price → promo →
   final per-day cost. Never hide the discount stack. If a promo expires soon,
   say so plainly; don't dramatize it with countdowns or urgency.

4. **Density with rhythm.** This is a personal tool — favor information
   density over breathing room, but vary spacing to create hierarchy. Tight
   inside a row, generous between sections. No identical-card grids.

5. **Respect the expert.** Use Polish domain terms as-is (kcal, dieta, tier,
   pakiet) — no unnecessary translation, no tooltips explaining the obvious.
   Polish-language data displayed natively.

## Commands

- **Dev / build**: `npm run dev`, `npm run build`, `npm run start`, `npm run typecheck`
- **Lint / format**: `npm run check` (oxlint via ultracite), `npm run fix` (auto-fix)
- **Tests**: `npm run test` (vitest), `npm run test:watch`, `npm run test:integration`
  (sets `INTEGRATION=1`; hits the live dietly.pl API)
- **Database**: `npm run migrate` then `migrate:v2`, `migrate:v3`, `migrate:v4`,
  `migrate:v5` in order
- **Scrapers**:
  - `npm run scrape` — full run (all companies in `CITY`, default `Wrocław`)
  - `npm run scrape:smoke` — robinfood only, no menus (fast sanity check)
  - `npm run scrape:menu-smoke` — robinfood with menus
  - `npm run scrape:promo-prices` — backfill prices using known promo codes
- **Cloudflare session** (rarely needed; only for the fallback fetch mode):
  `npm run cf-session` (parse cURL/HAR), `npm run cf-session:auto` (headless refresh)

`lefthook` runs oxlint + typecheck on pre-commit — don't bypass with `--no-verify`.

## Architecture

Three components share one Node/TypeScript codebase and one Postgres database:

1. **Scraper** (`scraper/`) — `tsx scraper/index.ts`. Orchestrates per-company
   scrapers (`city`, `companies`, `catalog`, `prices`, `menus`, `diet-tags`,
   `promotions`) against the reverse-engineered dietly.pl mobile API
   (`API.md`). Writes into Postgres (`db/schema.sql`). Supports a cron mode
   (`SCRAPE_SCHEDULER=1` or `--repeat`, daily at 06:00 Warsaw).
2. **Dashboard** (`app/`, `components/`, `lib/queries.ts`) — Next.js 16 App
   Router (React 19, Tailwind 4, Recharts, Radix UI). Server components read
   Postgres directly via `lib/queries.ts`; there is no API layer between UI
   and DB.
3. **MCP server** (`mcp/`, exposed at `app/api/mcp/route.ts`) — HTTP-mode
   Model Context Protocol server with tools `find_diets`, `get_menu`,
   `quote_order`, `place_order`, `login`. See `MCP.md`. Session state is
   in-memory, keyed by `mcp-session-id`; it resets on server restart.

**Data hierarchy** (from `db/schema.sql`):
`company → diet → tier → diet_option → diet_calories (leaf) → prices`.
`diet_calories_id` is globally unique and is the join key for `prices` and
`menus`.

**Shared HTTP client** (`scraper/api.ts`): handles base URL
(`https://aplikacja.dietly.pl`), required headers (`accept-language: pl-PL`
and `company-id: {slug}` on every `/company-card/...` call — the API rejects
without it), global concurrency semaphore (default 3), inter-request gap, and
exponential-backoff retries.

## Cloudflare bypass (non-obvious, load-bearing)

dietly.pl sits behind Cloudflare Bot Management. Two modes, toggled by
`DIETLY_USE_PATCHRIGHT` (default: `1` = patchright):

- **Patchright mode** (default): every request is routed through
  `page.evaluate(() => fetch(...))` on a persistent Chrome page launched by
  patchright (`scraper/cf-fetch.ts`, `scraper/cf-shared.ts`). Chrome's real
  TLS / HTTP/2 fingerprint passes CF. Profile persists at
  `~/.cache/dietlownik-cf-profile` — delete to reset. Set `CF_HEADLESS=0` to
  watch it run.
- **Fallback mode** (`DIETLY_USE_PATCHRIGHT=0`): plain `fetch` plus a manually
  captured cookie in `.cf-session.json` (use `npm run cf-session`). Brittle
  under any concurrency.

Don't "simplify" the scraper to plain `fetch` — the recent commit history is
a series of CF-bypass fixes. Keep concurrency low and intervals generous when
editing this code.

## Conventions worth knowing

- **Path alias**: `@/*` → repo root (`tsconfig.json`).
- **Module type**: ESM (`"type": "module"`). Lazy imports in the scraper use
  the `.js` extension on relative paths (e.g. `import("./scrapers/menus.js")`).
- **Polish data is native**: city names, diet names, etc. are stored as Polish
  (`Wrocław` etc.). Don't translate in queries or display.
- **Env vars** (loaded via `dotenv`; see `.env.example`):
  - Required: `DATABASE_URL`.
  - Scraper tuning: `CITY`, `COMPANY`, `LIMIT`, `COMPANY_CONCURRENCY`,
    `SKIP_MENUS`, `SKIP_PRICES`, `SKIP_PROMOS`, `SKIP_TAGS`,
    `SCRAPE_SCHEDULER`.
  - CF / HTTP tuning: `DIETLY_USE_PATCHRIGHT`, `CF_HEADLESS`, `MAX_IN_FLIGHT`,
    `MIN_INTERVAL_MS`, `RETRY_MAX`, `RETRY_BASE_MS`, `REQUEST_TIMEOUT_MS`.
- **Docker** (`Dockerfile`): single multi-stage image runs the Next server by
  default; override `CMD` for scraper or migration jobs.
