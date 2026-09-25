# dietlownik MCP server

An MCP server mounted inside the Next.js app. It gives an agent the same
thing the dashboard gives a person: plan catering day by day across every
catering, ranked against free-form Polish preferences, priced honestly, and
handed to the user's dietly basket.

- **Endpoint**: `/api/mcp`
- **Route**: `app/api/mcp/route.ts` (HTTP plumbing only)
- **Implementation**: `mcp/` — tools in `mcp/tools/`, registry in
  `mcp/tools/index.ts`, dispatch in `mcp/server.ts` and `mcp/tool.ts`,
  shared output shapes in `mcp/present.ts`
- **Transport**: streamable HTTP (JSON + SSE)
- **Runtime**: Node.js

## The two invariants

**1. `offer_id` is opaque.** It encodes
`v1:<company>:<diet_calories_id>[:<tier_diet_option_id>]` (`mcp/offer.ts`),
but callers treat it as a token: never parse, never hand-construct. If one
is rejected, re-run `plan` for a fresh one. Menu-configuration diets reuse
one `diet_calories_id` across their tiers (meal-count packages), so their
offers carry the tier in `tier_diet_option_id` (`<tier>-<option>`); inside
the server, read it with `tierIdOfOffer` in `mcp/offer.ts`.

**2. Sessions are isolated and in-memory.** Each MCP session gets its own
`DietlyClient`, so the dietly cookie jar is per-session, never
process-wide. Sessions are keyed by `mcp-session-id`, expire after 30
minutes idle, and are dropped on server restart. The dashboard's dietly
login (an httpOnly cookie) is separate from an MCP session's.

## Flow — the dashboard's, as tools

```
get_context → plan → (get_offer | find_diets) → quote → login → send_to_basket
```

| Dashboard                             | Tool                                         |
| ------------------------------------- | -------------------------------------------- |
| filter bar (city, dates, kcal, lists) | `get_context`                                |
| day-by-day list + plan summary        | `plan`                                       |
| expanded row / scatter for one day    | `plan` with one date and more `alternatives` |
| a day's meals, swapping a dish        | `get_offer`                                  |
| "zamów" → dietly basket               | `send_to_basket`                             |

Nothing in the MCP places or pays for an order. `send_to_basket` fills the
user's dietly basket; they check out on dietly.pl. (Until 0.4 there was a
`place_order` that charged the card on file; it was replaced by the basket
handoff the dashboard uses.)

## Tools

### `get_context`

Start here. Returns the cities with scraped data, the **orderable dates**
(menus scraped, at least 2 days out — dietly's lead time), kcal presets,
every catering as `id — name`, the sort options, the keyword vocabulary for
prefer/avoid, and data freshness (last menu scrape; last price scrape and
the share of quotes re-seen in the last 3 days).

### `plan`

The home page in one call. Per date: the winning offer under `sort`, its
meals with the reasons they scored, and alternatives (one per catering).
Then the plan's math and the selections to act on.

| Arg                       | Default         | Notes                                                                    |
| ------------------------- | --------------- | ------------------------------------------------------------------------ |
| `prefer` / `avoid`        | `[]`            | Free-form Polish, max 15 each. See "Keywords"                            |
| `kcal_min` / `kcal_max`   | 1500 / 2000     | The dashboard's defaults                                                 |
| `dates`                   | orderable dates | Up to 14                                                                 |
| `sort`                    | `score-desc`    | Any dashboard sort: `price-asc`, `protein-per-zl`, `review-desc`, …      |
| `alternatives`            | 3               | 0–10 runners-up per day, one per catering                                |
| `exclude` / `only`        | `[]`            | Catering ids                                                             |
| `detail`                  | `meals`         | `summary` · `meals` · `full` (ingredients, allergens, every dish option) |
| `include_shared_packages` | `false`         | "dla dwojga" / "duo" packages — see below                                |

Returns:

- `query` — what was actually applied (city, dates, kcal range, sort).
- `keywords` — per keyword: how it was understood (`allergen: gluten`,
  `macro: białko dużo`, `category: psiankowate`, lexical ingredient), how
  many chosen meals it hit, and a note when it was negated ("bez …") or
  matched by semantic similarity only.
- `days[]` — `pick` and `alternatives` as offer cards: catering, diet,
  tier, kcal, `price { list, per_day, promo }`, `score { best, default,
slots }`, `day_totals` (kcal and macros), rating, and for the pick the
  per-slot meals with hit reasons.
- `totals` — list total → savings → total, broken down per catering with
  its dates and promo codes (the dashboard's plan summary).
- `selections` — one per day: `{ date, offer_id, picks, promo_code }`, the
  input to `quote` and `send_to_basket`.

### `get_offer`

One offer on one date, fully expanded: each slot's chosen dish and, for
menu-choice diets, every other dish that could be swapped in — kcal,
protein, ingredients, allergens, hits. Returns a `selection` for that day;
swap a dish by replacing that slot's `meal_id`.

### `find_diets`

Catalog browse, independent of any menu: diet type (`KETO`, `VEGAN`, …,
case-insensitive), kcal, price, catering rating, promo-only. Prices are the
same current quotes the ranking uses: `list`, and `per_day` with the
cheapest code that catering accepted. Ratings count only when the catering
has reviews.

### `quote`

Live re-pricing on dietly's calculate-price endpoint — nothing ordered, no
login. Takes `selections`; days of one offer are quoted together (so real
order-length discounts show up). Each line reports list total, promo
discount and whether dietly **accepted** the code (a refused code is
retried without it and the reason returned), order-length discount,
delivery and total.

### `login`

Logs into the user's dietly account for this MCP session so
`send_to_basket` can write its basket. The password is not stored.

### `send_to_basket`

The dashboard's "zamów": writes one catering's selections into the user's
dietly basket and returns `basket_url`; the user reviews and pays on
dietly.pl. dietly's basket holds **one catering**, so a mixed plan is sent
catering by catering (`remaining_caterings` lists the rest). If the basket
already holds something else it returns `status: "conflict"` and writes
nothing; re-send with `replace: true` only after asking the user. Shares
`lib/dietly-basket-send.ts` with `app/api/dietly/basket/route.ts`.

## Keywords

Routing lives in `lib/preference-router.ts` (see `CLAUDE.md`, "Ranking
engine"). What an agent needs to know:

- Prefer/avoid are **soft scores, not filters**. For an allergy, read each
  meal's `allergens` in `get_offer` rather than trusting an avoid.
- `bez X` is moved to the other list: prefer `bez glutenu` = avoid `gluten`;
  genitives work (`bez jaj`, `bez orzechów`). `bez cukru` stays the
  low-sugar macro.
- Allergens match the spellings caterings use: `jaja` also matches
  `jajka`, `siarczyny` matches `dwutlenek siarki`, `gluten` also matches the
  gluten grains listed separately (pszenica, żyto, jęczmień, owies).
- A word matching no ingredient or dish name falls back to embedding
  similarity, which always finds _something_; `keywords[].note` flags it.

## "Dla dwojga" packages

19 caterings sell packages for two ("Pakiet dla DWOJGA", "PAKIET DUO",
"Duet Grande", "W duecie TANIEJ").
Their menus list every meal twice (slots `Obiad DD1` / `Obiad DD2`) and the
price covers both people. The day score is a sum over slots, so next to
one-person diets they win `score-desc` on slot count alone, and their
per-day price isn't comparable either. `plan` and `find_diets` leave them
out unless `include_shared_packages`.
The filter is `excludeSharedPackages` on `getRankedOffersForDay`; the
dashboard doesn't set it yet.

## Protocol

### Required Accept header

Every MCP `POST` must send:

```
Accept: application/json, text/event-stream
```

Missing or partial gets HTTP 406 with
`Not Acceptable: Client must accept both application/json and text/event-stream`.

### Session handshake

First call must be `initialize`; save the `mcp-session-id` response header and
send it on every later request. `GET /api/mcp` without a valid session
returns HTTP 400.

```bash
# 1. initialize — read mcp-session-id from the response headers
curl -i -X POST http://localhost:3000/api/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0", "id": 1, "method": "initialize",
    "params": {
      "protocolVersion": "2025-06-18",
      "capabilities": {},
      "clientInfo": { "name": "manual-test", "version": "0.0.1" }
    }
  }'

# 2. list tools
curl -X POST http://localhost:3000/api/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: <SESSION_ID>" \
  -d '{ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }'

# 3. call a tool
curl -X POST http://localhost:3000/api/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: <SESSION_ID>" \
  -d '{
    "jsonrpc": "2.0", "id": 3, "method": "tools/call",
    "params": {
      "name": "plan",
      "arguments": { "prefer": ["dużo białka"], "avoid": ["gluten"] }
    }
  }'
```

Local server URL while developing: `http://localhost:3000/api/mcp`
(`bun run dev`).

## Data dependencies

`get_context`, `plan`, `get_offer` and `find_diets` read the local scraper
database. Run migrations and a scrape before trusting their output — the
scrape's embed flush covers current and upcoming menus, so `bun run embed`
is only needed for past dates; see "Bootstrapping a database" in
`CLAUDE.md`. Only **tracked** cities have data
(`get_context().cities_with_data`; `bun run cities:track` manages them).
A tool given any other locality fails with `… is a real locality, but
dietlownik has no data for it` and names the tracked cities of the same
voivodeship — rather than resolving it and answering emptily.

`quote`, `login` and `send_to_basket` hit the live dietly API through
`mcp/http.ts` and `mcp/client.ts` (plain `fetch` with mobile-app headers —
`aplikacja.dietly.pl` doesn't challenge it, unlike the scraper's endpoints).

Tool responses are MCP text content with JSON payloads, plus
`structuredContent` validated against each tool's `outputSchema`.

## Order-days: one tier, on purpose

This project orders **day by day** and deliberately mixes suppliers, so the
scraper captures only the **1-day no-discount baseline**
(`ORDER_DAY_TIERS=[1]` in `scraper/scrapers/prices.ts`). Scraped prices are
per day with the best accepted promo code; `quote` is where real
multi-day order-length discounts show up.

## Troubleshooting

| Symptom                                            | Cause                                                     | Fix                                                              |
| -------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------- |
| HTTP 400 `No valid session ID provided`            | Non-initialize call without a valid `mcp-session-id`      | Send `initialize` first, reuse the returned id                   |
| HTTP 406 `Not Acceptable`                          | Missing Accept values                                     | Send `Accept: application/json, text/event-stream`               |
| 401 from an order tool                             | `login` not called, or session expired / server restarted | Call `login` again for the same email                            |
| 403 with `Just a moment` / `__cf_chl_` in the body | Cloudflare rate-limited the request                       | Retry in 5–30s                                                   |
| `Invalid offer_id ...`                             | Token parsed, invented, or from an older encoding         | Re-run `plan` for a fresh `offer_id`                             |
| `send_to_basket` → `status: "conflict"`            | Basket holds another catering or the user's own items     | Ask the user, then re-send with `replace: true`                  |
| Empty days in `plan`                               | Date not scraped, or kcal range / filters too narrow      | Use `get_context().orderable_dates`; widen `kcal_min`/`kcal_max` |
| `… is a real locality, but dietlownik has no data` | The city isn't tracked                                    | Use a tracked city it names (same voivodeship)                   |

Domain-specific recovery hints for dietly HTTP errors live in
`recoveryHint()` in `mcp/tool.ts`.
