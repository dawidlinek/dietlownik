# Dietlownik MCP Server

This project exposes a Model Context Protocol (MCP) server inside the Next.js app.

- Endpoint: `/api/mcp`
- Route file: `app/api/mcp/route.ts`
- Transport: streamable HTTP (JSON + SSE)
- Runtime: Node.js

## Quick start

1. Install dependencies.
2. Run the app.
3. Initialize an MCP session.
4. Call tools with the returned `mcp-session-id` header.

```bash
bun install
bun run dev
```

Server URL while developing locally:

- `http://localhost:3000/api/mcp`

## Protocol requirements

For MCP `POST` requests, include this `Accept` header:

- `Accept: application/json, text/event-stream`

If this header is missing or incomplete, the server returns:

- HTTP 406
- JSON-RPC error: `Not Acceptable: Client must accept both application/json and text/event-stream`

## Session model

The route keeps active MCP transports in memory, keyed by `mcp-session-id`.

- First call must be `initialize`.
- Save response header `mcp-session-id`.
- Include `mcp-session-id` in all later tool calls.
- `GET /api/mcp` without a valid session returns HTTP 400.

Important behavior:

- Session state is in memory only.
- A server restart drops MCP sessions.
- Login cookies for Dietly are also held in-memory per email.

## End-to-end handshake example

### 1) Initialize session

```bash
curl -i -X POST http://localhost:3000/api/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-06-18",
      "capabilities": {},
      "clientInfo": { "name": "manual-test", "version": "0.0.1" }
    }
  }'
```

Read `mcp-session-id` from response headers.

### 2) List tools

```bash
curl -X POST http://localhost:3000/api/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: <SESSION_ID>" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/list",
    "params": {}
  }'
```

### 3) Call a tool

```bash
curl -X POST http://localhost:3000/api/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: <SESSION_ID>" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "search_caterings",
      "arguments": {
        "city_id": 1
      }
    }
  }'
```

## Registered tools

### 1) `login`

Logs in to Dietly and stores auth cookies for the given email.

Input:

```json
{
  "email": "user@example.com",
  "password": "secret"
}
```

Returns:

- `email`
- `authenticated`
- `profile`
- `profile_address_ids`

### 2) `get_profile`

Fetches Dietly profile using stored session for `email`.

Input:

```json
{
  "email": "user@example.com"
}
```

Returns:

- `email`
- `profile`
- `profile_address_ids`

Notes:

- Call `login` first, otherwise request fails with 401 from the internal API helper.

### 3) `search_caterings`

Queries local Postgres for currently orderable catering options in a city.

Input:

```json
{
  "city_id": 986283,
  "diet_tag": "MENU_CONFIGURATION",
  "max_price_per_day": 80,
  "min_score": 85,
  "with_promo_only": true
}
```

Only `city_id` is required.

Returns up to 50 rows, including:

- company and diet metadata
- calories and latest 5-day `price_per_day`
- active campaign fields (`promo_code`, `promo_discount`, `promo_deadline`)

### 4) `get_meal_options`

Fetches meal options from Dietly open endpoints.

Input:

```json
{
  "company_id": "robinfood",
  "diet_calories_id": 65,
  "city_id": 986283,
  "date": "2026-04-30",
  "is_menu_configuration": false
}
```

For menu-configuration diets, also required:

- `base_meal_ids` (non-empty array)
- `tier_id`

If these are missing while `is_menu_configuration` is `true`, the tool throws an error.

### 5) `place_order`

Creates an order in Dietly shopping cart and returns payment URL and order ID.

Input:

```json
{
  "email": "user@example.com",
  "company_id": "robinfood",
  "profile_address_id": 123456,
  "diet_calories_id": 65,
  "tier_diet_option_id": "6-15",
  "delivery_dates": ["2026-05-01", "2026-05-02"],
  "meal_selections": [
    {
      "date": "2026-05-01",
      "meals": [
        { "diet_calories_meal_id": 1111 },
        { "diet_calories_meal_id": 2222 }
      ]
    },
    {
      "date": "2026-05-02",
      "meals": [
        { "diet_calories_meal_id": 3333 },
        { "diet_calories_meal_id": 4444 }
      ]
    }
  ],
  "promo_codes": ["ROBIM30"],
  "test_order": true
}
```

Returns:

- `payment_url`
- `order_id`
- `raw` (full Dietly order response)

## Operational notes

- `search_caterings` reads local DB tables (`companies`, `diets`, `tiers`, `diet_options`, `diet_calories`, `prices`, `campaigns`).
- Run scraper/migrations before relying on search results.
- Tool responses are returned as MCP text content containing JSON-serialized payloads.

## Troubleshooting

### HTTP 400: No valid session ID provided

Cause:

- Calling non-initialize request without valid `mcp-session-id`.

Fix:

1. Send `initialize` first.
2. Reuse returned `mcp-session-id` in every request.

### HTTP 406: Not Acceptable

Cause:

- Missing required `Accept` header values.

Fix:

- Send `Accept: application/json, text/event-stream`.

### 401 from authenticated tools

Cause:

- `login` was not called (or session expired/restarted).

Fix:

1. Call `login` again for the same email.
2. Retry authenticated tool.
