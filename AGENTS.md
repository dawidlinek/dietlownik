<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->

# dietlownik — agent entry point

**Read `CLAUDE.md` first.** It is the canonical brief: commands, the four
components, the database bootstrap order, and the load-bearing constraints
you can't infer from the code.

Deeper references, in the order you'll usually want them:

| File              | What it covers                                                    |
| ----------------- | ----------------------------------------------------------------- |
| `CLAUDE.md`       | Commands, architecture, conventions, design brief                 |
| `API.md`          | Reverse-engineered dietly.pl mobile API — endpoints, IDs, gotchas |
| `EMBEDDINGS.md`   | Semantic matching, model selection bench, τ calibration           |
| `MCP.md`          | The seven MCP tools and their contracts                           |
| `db/schema.sql`   | Data model at v13 — spans, meal variants, tier-aware leaves       |
| `.impeccable.md`  | Full design brief; read before any UI work                        |
| `bench/README.md` | Operator guide for re-running the embedding bench                 |

Three things that bite agents in this repo specifically:

1. **`bun`, not `npm`.** CI, `lefthook`, and Docker all use `bun.lock`. A
   `package-lock.json` also exists and can drift from it.
2. **A green test run can be meaningless.** Every DB-backed test skips
   without `DATABASE_URL` — 97 of 171, including all ranking,
   preference-routing, embedding and MCP coverage — and the run still exits 0. `vitest.setup.ts` loads `.env`, so point it at a database.
3. **One order-days tier is intentional.** The scraper captures only the
   1-day no-discount baseline (`ORDER_DAY_TIERS=[1]`) because this project
   orders day-by-day and mixes suppliers to win each day on its own merits.
   Never "restore" a 5/10/20-day assumption — treat order-days as a
   preference in SQL, never a filter.
