<img src="./docs/cover.jpg" alt="dietlownik.pl: Jedzenie na cały tydzień, wybrane w minutę" width="100%"/>

# dietlownik

Pick a week of catering diets in Poland by what you actually want to eat.

dietlownik scrapes every catering on [dietly.pl](https://dietly.pl) into
Postgres, reads every meal of every day's menu, and ranks the offers against
preferences written as plain Polish, like _„dużo białka, bez psiankowatych,
kurczak”_. The answer is one pick per day: **which catering, which diet, at
what price after the promo.**

No single catering wins every day, so it never picks one. Each day is priced
and scored on its own, and a week is free to mix three suppliers.

**[dietlownik.b.solvro.pl](https://dietlownik.b.solvro.pl)** · Wrocław today,
built for all 1 135 cities dietly delivers to.

---

## What's in the box

Four components, one repo, one Postgres database.

|                                                                   |                                                                                                                          |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Scraper** (`scraper/`)                                          | Catalog, prices, menus, promos and diet tags from dietly's mobile API, through a Cloudflare bypass. Daily cron at 06:00. |
| **Ranking engine** (`lib/queries.ts`, `lib/preference-router.ts`) | Routes Polish keywords across five channels and scores every meal of every offer. The heart of the project.              |
| **Dashboard** (`app/`, `components/`)                             | Next.js 16. Set a kcal band and some preferences; get a day-by-day plan with the promo math shown.                       |
| **MCP server** (`mcp/`)                                           | Seven tools that let an AI agent search, rank, plan a week, quote and place the order.                                   |

## Quick start

Requires Postgres 16+ with the `vector` and `pg_trgm` extensions, and
[bun](https://bun.sh), which CI, Docker and the git hooks all use.

```bash
bun install
cp .env.example .env          # only DATABASE_URL is required

node db/migrate-fresh.js --seed-taxonomy
bun run scrape:smoke          # one catering, no menus, takes minutes
bun run scrape                # a full city: ~3 h and ~15 GB
bun run embed                 # fills meal_embeddings

bun run dev                   # http://localhost:3000
```

## Connect an AI agent

The MCP server is mounted inside the app at `/api/mcp` over streamable HTTP.
Point any MCP client at:

```
http://localhost:3000/api/mcp
```

`find_diets` · `rank_day` · `plan_week` · `get_menu` · `quote_order` ·
`login` · `place_order`. Quoting needs no account; `place_order` is
irreversible and sits behind an explicit confirmation gate. Each MCP session
gets its own dietly cookie jar, held in memory for 30 idle minutes.
`MCP.md` has the contracts.

## How the ranking works

Every preference keyword is routed by `lib/preference-router.ts`. The first
three channels are exact-match and mutually exclusive; a keyword that matches
none of them goes to the last two:

1. **Allergen**: a synonym lexicon covering the 14 EU allergens
2. **Macro**: grammar like `dużo białka`, `niskie ig`, `mało tłuszczu`
3. **Category**: `ingredient_taxonomy` lookup, expanded to member ingredients
4. **Ingredient**: lexical `word_similarity() >= 0.6` with Polish stemming
5. **Embedding**: semantic match against `multilingual-e5-small` vectors
