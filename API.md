# dietly.pl reverse-engineered API

Notes from analysing `dietly.pl.har` (51 entries, captured on a company page in
Wrocław). Everything here is either directly observed in the HAR or marked
"inferred" where I had to extrapolate.

## Hosts & auth

- Base host: `https://dietly.pl`
- Anonymous browsing only requires a session cookie set by the Next.js app
  (no API key, no JWT). The `/api/dietly/open/...` and `/api/open/...` paths
  are explicitly public — they return data without any auth header.
- `/api/profile/*` paths require the user's session cookie (logged-in user) and
  are not relevant for scraping public diet/price catalogs.
- Useful request headers (the site sends them; most are not actually required,
  but the API checks `referer` softly):
  - `accept: application/json`
  - `referer: https://dietly.pl/catering-dietetyczny-firma/{companyId}`
  - `company-id: {companyId}` — sent on company-card endpoints. Probably used
    server-side for routing/multi-tenant; the slug in the path is also
    `{companyId}`.
  - `accept-language: pl` works fine.

## Identifiers used everywhere

| ID | Where it comes from | Example |
|---|---|---|
| `cityId` | `top-search` → `cities[].cityId` | `986283` (Wrocław) |
| `companyId` | a slug; URL-stable; e.g. `robinfood` | `robinfood` |
| `dietId` | `companyDiets[].dietId` | `4` ("Wybór menu") |
| `tierId` | `companyDiets[].dietTiers[].tierId` | `6` ("Pakiet Comfort") |
| `dietOptionId` | `dietTiers[].dietOptions[].dietOptionId` | `15` ("Standard Food") |
| `tierDietOptionId` | `"{tierId}-{dietOptionId}"` | `"6-15"` |
| `dietCaloriesId` | leaf node — picks a specific kcal level | `65` (1200 kcal Standard Food) |

The hierarchy is: **company → diet → tier → dietOption → dietCalories**. The
`dietCaloriesId` is the only thing the price endpoint actually needs (plus
optional `tierDietOptionId` if the diet supports menu configuration).

---

## 1. Discovery

### `GET /api/open/search/top-search`

Query params:
- `query` (string, URL-encoded; e.g. `Wroc%C5%82aw`)
- `citiesSize` (int) — max cities to return
- `companiesSize` (int) — max companies to return

Response:
```jsonc
{
  "cities": [
    {
      "cityId": 986283,
      "name": "Wrocław",
      "sanitizedName": "wroclaw",
      "countyName": "Wrocław",
      "municipalityName": "Wrocław",
      "provinceName": "DOLNOŚLĄSKIE",
      "cityStatus": true,             // true = a city the platform supports
      "numberOfCompanies": 156,        // cateringa active in this city
      "largestCityForName": false
    }
  ],
  "companies": [],                     // populated when companiesSize > 0
  "diets": [],
  "moreCitiesAvailable": false,
  "moreCompaniesAvailable": false,
  "moreDietsAvailable": false
}
```

This is the canonical way to look up a `cityId` from a name.

### Listing all companies in a city — *not in HAR, inferred*

The Next.js page at `https://dietly.pl/catering-dietetyczny/{citySlug}` (e.g.
`/catering-dietetyczny/wroclaw`) lists every catering with prices. Two ways to
get its data without parsing HTML:

1. **Next.js page-data JSON.** The HAR shows the analogous request for the
   single-company page:
   `GET /_next/data/{buildId}/catering-dietetyczny-firma/{companyId}.json?companyId={companyId}`
   The buildId (`jekAjoBrwS6rgioh0IGjO` in this HAR) rotates on every deploy —
   parse it from any HTML page (`<script id="__NEXT_DATA__">.buildId`). The
   listing equivalent would be
   `/_next/data/{buildId}/catering-dietetyczny/{citySlug}.json`.
2. **Use `top-search`** with `companiesSize=200&query={cityName}` — the HAR
   only shows `companiesSize=0`, but the `companies` field exists in the
   response shape.

If a stable, no-HTML path matters, option 2 is preferable because it doesn't
depend on the rotating buildId.

---

## 2. Company-card endpoints

All of these are scoped to one `(companyId, cityId)` pair.

### `GET /api/dietly/open/company-card/{companyId}/constant?cityId={cityId}`

The big one — returns the full catalog of diets, tiers, options, and the kcal
matrix for a company in a given city. Response top-level keys:

```jsonc
{
  "companyDiets": [...],     // diets/tiers/options tree (see below)
  "companyHeader": {...},    // name, logo, ratings, active promo banner
  "companyParams": {...},    // booleans (deliveryOnSaturday, etc.)
  "companySideOrders": [...],
  "contactDetails": {...},
  "deliveryCities": [...],   // other cities the catering delivers to
  "formSettings": {...},
  "images": [...],
  "menuSettings": { "menuEnabled": true, "menuDaysAhead": 18 },
  "programs": [...]          // marketing copy
}
```

Per-diet shape (`companyDiets[i]`):
```jsonc
{
  "dietId": 4,
  "name": "Wybór menu",
  "description": "...",
  "imageUrl": "https://ml-assets.com/.../robinfood-4-88bf.jpg",
  "awarded": false,
  "avgScore": 94.0,
  "feedbackValue": 4.74,
  "feedbackNumber": 277,
  "dietTag": "MENU_CONFIGURATION",      // see /api/open/diet-tag-info/all
  "isMenuConfiguration": true,           // true → user picks meals; uses tiers
  "dietMealCount": 40,
  "discounts": [
    { "discount": 5.0,  "minimumDays": 5,  "discountType": "PERCENTAGE" },
    { "discount": 10.0, "minimumDays": 10, "discountType": "PERCENTAGE" }
  ],
  "dietTiers": [
    {
      "tierId": 6,
      "name": "Pakiet Comfort",
      "minPrice": "67.00 zł",            // string, not numeric
      "mealsNumber": 25,
      "defaultOptionChange": true,
      "tag": null,                        // or "BESTSELLER", "VEGE", etc.
      "dietOptions": [
        {
          "dietOptionId": 15,
          "tierDietOptionId": "6-15",
          "name": "Standard Food",
          "dietOptionTag": "STANDARD",
          "dietCalories": [
            { "dietCaloriesId": 65, "calories": 1200 },
            { "dietCaloriesId": 66, "calories": 1500 },
            { "dietCaloriesId": 67, "calories": 1800 },
            { "dietCaloriesId": 68, "calories": 2000 },
            { "dietCaloriesId": 184, "calories": 2200 },
            { "dietCaloriesId": 69, "calories": 2500 },
            { "dietCaloriesId": 70, "calories": 3000 }
          ],
          "defaultOption": true
        }
      ]
    }
  ]
}
```

For "ready" (non-configurable) diets, `dietTiers` is empty and the diet itself
has its kcal matrix collapsed into a single price tier — the *price* endpoint
below is what you need then.

### `GET /api/dietly/open/company-card/{companyId}/city/{cityId}`

Lightweight. Returns headline pricing and city info — useful when you only need
"what's the cheapest plan?" without all the diet tree:

```jsonc
{
  "dietPriceInfo": [
    {
      "dietId": 4,
      "discountPrice": "62.00 zł",
      "defaultPrice": "62.00 zł",
      "dietCaloriesIds": [147, 148, ...],   // every kcal node available for this diet
      "dietPriceInCompanyPromotion": false
    }
  ],
  "companySettings": { "ordersEnabled": true, "deliveryEnabled": true },
  "companyPriceCategory": "CHEAP",            // CHEAP / MEDIUM / EXPENSIVE
  "awarded": true,
  "citySearchResult": {
    "cityId": 986283, "name": "Wrocław", "deliveryFee": null, ...
  },
  "lowestPrice": {
    "standard": "57.00 zł",                   // cheapest "ready" diet
    "menuConfiguration": "62.00 zł"           // cheapest configurable diet
  }
}
```

The `defaultPrice`/`discountPrice` here are **per-day** prices and they are
the *advertised* baseline. They do not reflect order-length discounts.

### `POST /api/dietly/open/company-card/{companyId}/quick-order/calculate-price`

This is the truthful price oracle. Use it when comparing — it applies
order-length discounts, promo codes, etc.

Body:
```json
{
  "promoCodes": [],
  "deliveryDates": ["2026-04-29", "2026-04-30", "..."],
  "dietCaloriesId": 77,
  "testOrder": false,
  "cityId": 986283,
  "tierDietOptionId": "6-15"
}
```

- `deliveryDates` is the list of *individual delivery days*. Length of this
  array is what triggers the "longer order = bigger discount" tiers.
- `tierDietOptionId` is **omitted** for non-tiered (ready) diets — only sent
  for `isMenuConfiguration: true` diets.
- `promoCodes`: e.g. `["ROBIM30"]`.

Response:
```jsonc
{
  "cart": {
    "totalCostToPay": 603.00,
    "totalCostWithoutDiscounts": 670.00,
    "totalLowest30DaysCostWithoutDiscounts": 680.00,   // for "Omnibus" disclosure
    "totalDeliveryCost": 0.00,
    "totalPromoCodeDiscount": 0,
    "totalOrderLengthDiscount": 67.00,
    "totalDeliveriesOnDateDiscount": 0.00,
    "totalLoyaltyPointsDiscount": 0.00,
    "totalPickupPointDiscount": 0.00,
    "totalOneTimeSideOrdersCost": 0,
    "totalAwardedLoyaltyProgramPoints": 0,
    "totalAwardedGlobalLoyaltyProgramPoints": 0
  },
  "items": [
    {
      "itemId": "company-visiting-card-quick-order",
      "perDayDietCost": 67.00,                  // pre-discount per-day
      "perDayDietWithDiscountsCost": 60.30,     // post-discount per-day
      "totalDietWithDiscountsAndSideOrdersCost": 603.00,
      "totalDietWithSideOrdersCost": 670.00,
      "totalDietWithoutSideOrdersCost": 670.00,
      "totalSideOrdersCost": 0.00
    }
  ]
}
```

### `GET /api/dietly/open/company-card/{companyId}/menu/{dietCaloriesId}/city/{cityId}/date/{YYYY-MM-DD}?tierId={tierId}`

Day-level menu — the actual meals. `tierId` is optional (only for menu-
configuration diets). Only useful if you want food details, not pricing.

Response shape:
```jsonc
{
  "date": "2026-04-29",
  "calories": 1200,
  "meals": [
    {
      "name": "Śniadanie",
      "baseDietCaloriesMealId": 298,
      "options": [
        {
          "dietCaloriesMealId": 358,
          "name": "...",
          "label": "Fit Food",
          "info": "295 kcal • B:14g • W:19g • T:17g",
          "thermo": "COLD",
          "reviewsNumber": 781,
          "reviewsScore": 90.65,
          "details": {
            "name": "...",
            "allergens": "Mleko, gluten, ...",
            "allergensWithExcluded": [...],
            "ingredients": [...]
          }
        }
      ]
    }
  ]
}
```

Allowed dates run `today + 1` up to `today + menuSettings.menuDaysAhead`
(18 in this HAR). Note the URL takes `dietCaloriesId` (the leaf, kcal-specific
ID), **not** `dietId`.

### `GET /api/dietly/open/company-card/{companyId}/feedback?pageSize=10&sort=DATE`

Reviews. Optional `page` query param (0-indexed). Response:
```jsonc
{
  "results": [{ "feedbackId": "...", "userName": "...", "dietId": 4, "avgScore": 5.0, "text": "...", ... }],
  "pageNumber": 0,
  "totalPages": 31,
  "aggregation": {
    "avgTaste": 4.7, "avgScore": 4.76, "count": 298, ...
  }
}
```

---

## 3. Reference data

### `GET /api/open/diet-tag-info/all`

Big static catalog of diet *tags* (Standard, Keto, Wege, Samurai, ...) with
human descriptions, allowed kcal levels, and image URLs. Use this to map the
`dietTag` strings on each `companyDiet` to a presentable label.

### `GET /api/dietly/open/form-settings`

Per-company contact data, social URLs, descriptions, packaging info, kitchen
address. Bulk reference data.

### `GET /api/open/feature-flags`

Just a list of strings: `["enable-dietly-shop", "enable-social-auth", ...]`.

### `GET /api/open/campaign-settings/active-campaign`

Active site-wide promotion: code, title, dates, discount %, banner image.

---

## 4. Recommended workflow for diet/price comparison

1. **Resolve city.** `top-search?query={name}&citiesSize=10&companiesSize=0` →
   pick the one with `cityStatus: true`.
2. **List companies in that city.** Either
   - `top-search?query={cityName}&citiesSize=0&companiesSize=200`, or
   - fetch `/_next/data/{buildId}/catering-dietetyczny/{citySlug}.json` (need
     to extract `buildId` from any page's `__NEXT_DATA__` first).
3. **For each `companyId`:** fetch
   `/api/dietly/open/company-card/{companyId}/constant?cityId={cityId}`
   to get the full diet/tier/option tree + kcal IDs.
4. **For each (diet, tier, option, kcal) leaf you care about:** call
   `POST /quick-order/calculate-price` with the desired number of days. This
   gives the apples-to-apples discounted price you'd actually pay.
5. (Optional) Pull menu samples via the `/menu/{dietCaloriesId}/...` endpoint
   and reviews via `/feedback`.

### Picking dates for `calculate-price`

Use *consecutive future weekdays* respecting the company's
`companyParams.deliveryOnSaturday` / `deliveryOnSunday` flags. The "discount
tier" depends on the *count* of dates, so if you want to see e.g. the 5-day,
10-day, and 20-day prices, run the call three times with different array
lengths.

---

## Caveats

- All prices are returned as PLN strings with `" zł"` suffix (e.g. `"62.00 zł"`)
  on the `constant`/`city` endpoints, but as JSON numbers on
  `calculate-price`. Strip/parse accordingly.
- The HAR was captured anonymously; rate limits weren't observable but be
  polite (sleep between calls; the site is a real business).
- `top-search` was only seen with `companiesSize=0` in this capture — the
  documented `companiesSize=N` behaviour is inferred from the response shape
  (`companies: []` field) and the comparison-engine Redux slice. Verify with a
  single test call before relying on it.
- The `_next/data` `buildId` rotates on deploys — don't hard-code it.
