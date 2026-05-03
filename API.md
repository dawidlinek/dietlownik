# dietly.pl mobile API — reverse-engineered

Notes from analysing `HTTPToolkit_2026-04-26_21-20.har` (232 entries, captured
from the **Android app** browsing Wrocław, companies `robinfood` and
`mangodiet`). Everything here is directly observed in the HAR; "inferred" tags
mark the few places I had to extrapolate.

The previous capture (commit `9420f3e`) covered the **website** at
`https://dietly.pl/api/dietly/open/...`. This one covers the mobile app at
`https://aplikacja.dietly.pl/api/mobile/open/...`. The mobile endpoints return
slightly richer data (tier descriptions, human-readable delivery info) and
expose a few endpoints the web app doesn't (notably `/menu/...` with full
nutrition + ingredients per dish, and `/awarded-and-top` with the entire
city catalog). Prefer mobile.

## Hosts & auth

- Base host: `https://aplikacja.dietly.pl`
- All `/api/mobile/open/...` and `/api/open/...` endpoints are **anonymous** —
  no cookies, no API key, no JWT.
- `/api/profile/...` paths require a logged-in session (observed: 401 for
  `coupons-search` without auth). We can't use the coupons endpoint
  programmatically; see "Promo codes" below for the workaround.

The Android app sends:

```
content-type: application/json
accept-language: pl-PL
x-launcher-type: ANDROID_APP
x-mobile-version: 4.0.0
company-id: {companyId}        # only on company-card endpoints; URL already has it, header is redundant
user-agent: okhttp/4.9.2
```

In practice the API enforces `accept-language` (Polish content), `content-type`
on POSTs, and — verified by live testing — the **`company-id` header is required**
for every `/api/mobile/open/company-card/{companyId}/...` request. Without it
the server returns 400, even though the same companyId is in the URL path.
`x-launcher-type` and `x-mobile-version` are safe to forge.

No rate-limit headers were observed. Be polite: 1–2 req/s per company.

## Identifiers

Hierarchy: **company → diet → tier → dietOption → dietCalories** (leaf).

| ID                   | Where it comes from                                    | Example                                   | Notes                                                                                               |
| -------------------- | ------------------------------------------------------ | ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `cityId`             | `top-search` → `cities[].cityId`, also `cities/top-10` | `986283` (Wrocław)                        | `int`                                                                                               |
| `companyId`          | URL slug; `awarded-and-top` returns `name` (= slug)    | `robinfood`, `mangodiet`                  | `string`, URL-stable                                                                                |
| `dietId`             | `companyDiets[].dietId`                                | `4` ("Wybór menu"), `9` ("Standard Food") | `int`                                                                                               |
| `tierId`             | `dietTiers[].tierId`                                   | `6` ("Pakiet Comfort")                    | `int`. Only set for menu-config diets.                                                              |
| `dietOptionId`       | `dietOptions[].dietOptionId`                           | `15` ("Standard Food")                    | `int`                                                                                               |
| `tierDietOptionId`   | composite `"{tierId}-{dietOptionId}"`                  | `"6-15"`                                  | `string`. Required by `quick-order/calculate-price` for menu-config diets, omitted for fixed diets. |
| `dietCaloriesId`     | `dietCalories[].dietCaloriesId` (leaf)                 | `65` (1200 kcal Standard)                 | `int`. **The only ID strictly needed for pricing and menu queries.**                                |
| `dietCaloriesMealId` | `meals[].options[].dietCaloriesMealId`                 | `358`                                     | `int`. The per-day, per-kcal, per-dish ID — use this to track menus over time.                      |

Two diet shapes coexist within the same company:

- **Menu-config diet** (e.g. `dietId=4`, "Wybór menu"): `dietTiers` is non-empty
  and contains `dietOptions` per tier; the diet's top-level `dietOptions` is
  empty. Pricing requires `tierDietOptionId`.
- **Fixed/ready diet** (e.g. `dietId=9`, "Standard Food"): `dietTiers` is empty
  and `dietOptions` lives at the diet level. No `tierDietOptionId` needed.

`isMenuConfiguration` and `dietTag == "MENU_CONFIGURATION"` flag the first
shape.

---

## 1. Discovery

### `GET /api/open/search/top-search?query={name}&citiesSize={n}&companiesSize={n}&cityId=`

Resolve a city name to a `cityId`. Identical shape to the web API.

```jsonc
{
  "cities": [
    {
      "cityId": 986283,
      "name": "Wrocław",
      "sanitizedName": "wroclaw",
      "provinceName": "DOLNOŚLĄSKIE",
      "cityStatus": true,
      "numberOfCompanies": 156
    }
  ],
  "companies": [],            // populated if companiesSize > 0 — not exercised in HAR
  "diets": [],
  "moreCitiesAvailable": false,
  ...
}
```

### `GET /api/mobile/open/cities/top-10`

Top-10 cities with delivery-window info. Useful as a seed list.

```jsonc
[
  {
    "cityId": 918123,
    "name": "Warszawa",
    "sanitizedName": "warszawa",
    "sectorId": 86,
    "deliveryFee": null,
    "deliveryTime": [
      { "deliveryTimeId": 229, "timeFrom": "23:59:59", "timeTo": "08:00:00" },
    ],
  },
]
```

`timeFrom: "23:59:59"` is the API's "open-ended / overnight" sentinel.

### `GET /api/dietly-shop/open/supported-cities`

Full list of supported cities for the Dietly Shop product. Not exercised in
HAR but listed here for completeness.

### `GET /api/open/search/full/awarded-and-top?cId={cityId}&page={n}&pageSize={n}&rV=V2023_1&active=`

**The catalog endpoint.** Lists every company that delivers to a city, with
ratings, params, and any active promotion. For Wrocław the HAR shows
`totalElements=152` over 16 pages of 10. Use `rV=V2023_1` — it returns more
fields than the legacy variant.

```jsonc
{
  "city": { ... },
  "currentPage": 0,
  "totalPages": 16,
  "totalElements": 152,
  "histogramResponses": { ... },        // rating distribution
  "searchData": [
    {
      "name": "robinfood",                // <- companyId slug
      "fullName": "Robin Food",
      "rate": 4.76,
      "numberOfRates": 298,
      "awarded": true,
      "priceCategory": "CHEAP",          // CHEAP / AVERAGE / EXPENSIVE
      "dietNames": ["dieta Standard Food", ...],
      "numberOfDiets": 8,
      "inviteCodeDiscountPercent": 20.0, // referral discount
      "shortDescription": "...",
      "params": {
        "deliveryOnSaturday": true,
        "deliveryOnSunday": true,
        "selfPickup": false,
        "loyaltyProgramEnabled": true,
        "menuSelectionEnabled": true,
        "hasDietWithMenuConfiguration": true,
        "hasActivePromotions": true,
        ...
      },
      "activePromotionInfo": {
        "promoText": "Promocja -30%  KOD:ROBIM30",
        "promoDeadline": "2026-04-26",
        "code": "ROBIM30",
        "discountPercents": 30
      },
      "galleryImages": [ ... ],
      "orderPossibleOn": "2026-04-29",
      "orderPossibleTo": "2026-04-27T06:00:00"
    }
  ]
}
```

`searchData[].name` is the `companyId` slug — feed it into `/company-card/...`
endpoints.

### `GET /api/open/search/saved-meal-offers/count?cityId={cityId}`

Returns an integer count of "Paczki Niespodzianki" offers in a city. Not
useful for catalog scraping.

---

## 2. Company catalog

All scoped to a `(companyId, cityId)` pair. The `company-id` request header
must match the slug in the URL — it's a hard requirement, not a hint.

### `GET /api/mobile/open/company-card/{companyId}/constant?cityId={cityId}`

Full diet/tier/option/kcal tree plus header, contact, gallery, side-orders.

Top-level keys:

```jsonc
{
  "companyHeader":   { ... },   // name, logos, ratings, activePromotionInfo, deliveryInfo
  "companyParams":   { ... },   // bool flags (deliveryOnSaturday, loyaltyProgramEnabled, ...)
  "companyDiets":    [ ... ],   // diet/tier/option tree (see below)
  "companySideOrders": [ ... ],
  "contactDetails":  { ... },
  "deliveryCities":  [ ... ],
  "formSettings":    { ... },
  "images":          [ ... ],
  "menuSettings":    { "menuEnabled": true, "menuDaysAhead": 18 },
  "programs":        [ ... ]
}
```

`companyHeader` (note: when there's no active promo, all `activePromotionInfo`
fields are `null`/`false`; otherwise `code` is the promo code):

```jsonc
{
  "name": "mango.diet",
  "logoUrl": "https://ml-assets.com/...",
  "rateValue": 92.0, // 0–100
  "feedbackValue": 4.82, // 0–5
  "feedbackNumber": 369,
  "activePromotionInfo": {
    "promoText": "Promocja -30%  KOD:MG30",
    "promoDeadline": "2026-05-03",
    "code": "MG30",
    "discountPercents": 30,
    "separate": true, // true = code not auto-applied to advertised price
  },
  "deliveryInfo": {
    "date": "2026-04-28",
    "text": "Zamów do 05:00 (jutro) - dostawa we wtorek",
  },
  "rate": 4.82,
  "dietlyDelivery": true, // delivered by Dietly's logistics, not the catering
}
```

Per-diet, menu-config shape:

```jsonc
{
  "dietId": 4,
  "name": "Wybór menu",
  "dietTag": "MENU_CONFIGURATION",
  "isMenuConfiguration": true,
  "imageUrl": "https://ml-assets.com/images/diets/robinfood/robinfood-4-88bf.jpg",
  "avgScore": 94.0,
  "feedbackValue": 4.74,
  "feedbackNumber": 277,
  "dietMealCount": 40,
  "dietOptions": [], // empty for menu-config; lives under tiers
  "dietTiers": [
    {
      "tierId": 6,
      "name": "Pakiet Comfort",
      "description": "25 posiłków do wyboru codziennie",
      "minPrice": "67.00 zł", // string with currency!
      "mealsNumber": 25,
      "tag": null, // "BESTSELLER", "VEGE", etc.
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
            { "dietCaloriesId": 70, "calories": 3000 },
          ],
          "defaultOption": true,
        },
      ],
    },
  ],
  "discounts": [
    { "discount": 5.0, "minimumDays": 5, "discountType": "PERCENTAGE" },
    { "discount": 10.0, "minimumDays": 10, "discountType": "PERCENTAGE" },
  ],
}
```

Per-diet, fixed shape (`dietId=9`, "Standard Food"):

```jsonc
{
  "dietId": 9,
  "name": "dieta Standard Food",
  "dietTag": "STANDARD",
  "isMenuConfiguration": false,
  "dietTiers": [],
  "dietOptions": [
    {
      "dietOptionId": 27,
      "name": "Standard Food",
      "dietOptionTag": "STANDARD",
      "dietCalories": [
        { "dietCaloriesId": 140, "calories": 1200 },
        { "dietCaloriesId": 141, "calories": 1500 },
        ...
      ]
    }
  ]
}
```

Robinfood/Wrocław has 8 diets: `Wybór menu` (4) and seven fixed diets (9, 7,
10, 8, 12, 11, 13) tagged `STANDARD / DASH / LOW IG / GLUTEN LACTOSE FREE /
LOW CARB / SPORT / HOME`.

### `GET /api/mobile/open/company-card/{companyId}/city/{cityId}`

Lightweight pricing snapshot.

```jsonc
{
  "dietPriceInfo": [
    {
      "dietId": 16,
      "discountPrice": "73.50 zł", // post-promo headline
      "defaultPrice": "105.00 zł", // pre-promo
      "dietCaloriesIds": [103, 104, 105], // every kcal node for this diet
      "dietPriceInCompanyPromotion": true,
    },
  ],
  "companySettings": { "ordersEnabled": true, "deliveryEnabled": true },
  "companyPriceCategory": "AVERAGE", // CHEAP / AVERAGE / EXPENSIVE
  "awarded": true,
  "citySearchResult": {
    "cityId": 986283,
    "name": "Wrocław",
    "sectorId": 66,
    "deliveryFee": null,
    "deliveryTime": [
      { "deliveryTimeId": 107, "timeFrom": "23:59:59", "timeTo": "06:00:00" },
    ],
  },
  "lowestPrice": {
    "standard": "54.60 zł", // cheapest fixed diet
    "menuConfiguration": "60.90 zł", // cheapest menu-config diet
  },
}
```

Note: `discountPrice/defaultPrice` are **advertised** rates and ignore order
length. For the truthful number use `quick-order/calculate-price`.

### `GET /api/mobile/open/company-card/{companyId}/feedback?sort=DATE&page={n}&pageSize={n}`

Reviews. `aggregation` has score histograms; `results[]` has per-review fields
including six dimensional scores (`scoreTaste`, `scoreAesthetics`,
`scoreIngredientsQuality`, `scorePackaging`, `scoreVariety`, `scoreDelivery`),
`orderDuration`, `lastDeliveryDate`, `verified`, optional `responseText`.

---

## 3. Pricing — the only truthful numbers

### `POST /api/mobile/open/company-card/{companyId}/quick-order/calculate-price`

Apples-to-apples per-day price. Use this for cross-company comparison.

Body (menu-config diet — `tierDietOptionId` required):

```json
{
  "cityId": 986283,
  "deliveryDates": ["2026-04-26"],
  "dietCaloriesId": 65,
  "tierDietOptionId": "6-15",
  "promoCodes": [""],
  "testOrder": false
}
```

Body (fixed diet — omit `tierDietOptionId`):

```json
{
  "cityId": 986283,
  "deliveryDates": ["2026-04-26"],
  "dietCaloriesId": 140,
  "promoCodes": [""]
}
```

`deliveryDates` is a list of individual days. **Order-length discount is
applied based on the array length** — pass 5 days for 5%, 10 days for 10%, etc.
Empty strings in `promoCodes` are tolerated.

Response (no promo):

```jsonc
{
  "cart": {
    "totalCostToPay": 67.0, // float, PLN, post-discounts
    "totalCostWithoutDiscounts": 67.0,
    "totalLowest30DaysCostWithoutDiscounts": null, // Omnibus disclosure, set when promo applied
    "totalDeliveryCost": 0.0,
    "totalPromoCodeDiscount": 0,
    "totalPromoCodeDiscountInfo": "",
    "totalOrderLengthDiscount": 0.0,
    "totalDeliveriesOnDateDiscount": 0.0,
    "totalLoyaltyPointsDiscount": 0.0,
    "totalPickupPointDiscount": 0.0,
    "totalOneTimeSideOrdersCost": 0,
    "totalAwardedLoyaltyProgramPoints": 0,
    "totalAwardedGlobalLoyaltyProgramPoints": 0,
  },
  "items": [
    {
      "itemId": "company-visiting-card-quick-order",
      "perDayDietCost": 67.0,
      "perDayDietWithDiscountsCost": 67.0,
      "totalDietWithDiscountsAndSideOrdersCost": 67.0,
      "totalDietWithSideOrdersCost": 67.0,
      "totalDietWithoutSideOrdersCost": 67.0,
      "totalSideOrdersCost": 0.0,
      "totalCutleryCost": 0.0,
      "totalSideOrdersWithoutCutleryCost": 0.0,
      "totalMealsChosenCost": 0,
    },
  ],
}
```

Response (mango.diet, 1 day, `promoCodes: ["MG30"]`):

```jsonc
{
  "cart": {
    "totalCostToPay": 61.60,
    "totalCostWithoutDiscounts": 88.00,
    "totalLowest30DaysCostWithoutDiscounts": 85.00,   // Omnibus reference price
    "totalPromoCodeDiscount": 26.40,
    "totalPromoCodeDiscountInfo": "",
    ...
  },
  ...
}
```

The `MG30` example is concrete proof the API accepts public promo codes for
anonymous quotes — we use this to validate codes scraped from banners.

### `POST /api/mobile/open/shopping-cart/calculate-price`

Full cart with hand-picked meals, side orders, loyalty points, multi-order.

Body:

```json
{
  "cityId": 986283,
  "companyId": "robinfood",
  "promoCodes": [],
  "loyaltyProgramPoints": 0,
  "loyaltyProgramPointsGlobal": 0,
  "simpleOrders": [
    {
      "itemId": "Ll5v-YFDomCtdwOP4KyRQ", // client-generated, opaque
      "deliveryDates": ["2026-04-29", "2026-04-30", "..."],
      "customDeliveryMeals": {}, // per-date overrides; empty = same meals every day
      "deliveryMeals": [
        { "amount": 1, "dietCaloriesMealId": 676 },
        { "amount": 1, "dietCaloriesMealId": 680 },
        { "amount": 1, "dietCaloriesMealId": 692 },
        { "amount": 1, "dietCaloriesMealId": 699 },
        { "amount": 1, "dietCaloriesMealId": 701 }
      ],
      "dietCaloriesId": 145,
      "paymentType": "ONLINE",
      "pickupPointId": null,
      "sideOrders": [],
      "testOrder": false
    }
  ]
}
```

Response shape is the same `{ cart, items }`. Loyalty points awarded scale
with the order (5 meals × 1 day = 50 points; 5 meals × 10 days = 750 points).

`deliveryDates: []` is valid and treats the order as a 1-day quote.

---

## 4. Menus — what we want to track over time

### `GET /api/mobile/open/company-card/{companyId}/menu/{dietCaloriesId}/city/{cityId}/date/{YYYY-MM-DD}`

Optional query: `?tierId={tierId}` (only for menu-config diets).

```jsonc
{
  "date": "2026-04-26",
  "calories": 1200,
  "meals": [
    {
      "name": "Śniadanie",                        // Polish meal-type label
      "baseDietCaloriesMealId": 298,              // default option for this slot
      "options": [
        {
          "dietCaloriesMealId": 358,
          "name": "Pasta twarogowa z szynką z chlebem żytnim ze słonecznikiem i papryką",
          "label": "Fit Food",                    // dietOption variant label
          "info": "300 kcal • B:19g • W:30g • T:11g",   // B=Białka(prot), W=Węglowodany(carbs), T=Tłuszcze(fat)
          "thermo": "COLD",                       // COLD / WARM / COLD_WARM
          "reviewsNumber": 46,
          "reviewsScore": 97.83,
          "details": {
            "name": "...",
            "imageUrl": "https://ml-assets.com/images/diets/robinfood/robinfood-706069CLIENT-6286.jpg",
            "calories": "300.45 kcal / 1257 kJ",
            "protein": "18.87g",
            "carbohydrate": "30.46g",
            "fat": "11.46g",
            "saturatedFattyAcids": "1.22g",
            "sugar": "4.27g",
            "salt": "2.26g",
            "dietaryFiber": "3.08g",
            "thermo": "COLD",
            "allergens": "Mleko, Zboża zawierające gluten, ...",   // pretty string
            "allergensWithExcluded": [
              {
                "dietaryExclusionId": 1,
                "companyAllergenName": "Zboża zawierające gluten, tj. pszenica, ...",
                "dietlyAllergenName": "gluten",                       // <- normalized, use this
                "excluded": false
              }
            ],
            "ingredients": [
              { "name": "Twaróg sernikowy (twaróg(MLEKO))", "major": false, "exclusion": [] }
            ]
          }
        }
      ]
    },
    { "name": "II Śniadanie",  "baseDietCaloriesMealId": ..., "options": [...] },
    { "name": "Obiad",         "baseDietCaloriesMealId": ..., "options": [...] },
    { "name": "Podwieczorek",  "baseDietCaloriesMealId": ..., "options": [...] },
    { "name": "Kolacja",       "baseDietCaloriesMealId": ..., "options": [...] }
  ]
}
```

Robinfood serves 5 meal-types × 5 options each per day for `dietCaloriesId=65`
(1200 kcal, Standard). Mango Wrocław serves 5 meal-types × 6 options each.

For tracking changes day-over-day or week-over-week, the stable identifier is
`dietCaloriesMealId`. The same dish will keep its ID; what changes is which
IDs appear on which day. Macros and ingredients are stable per-ID.

`menuSettings.menuDaysAhead` (from `/constant`) bounds how many days into the
future you can query — 18 days for the cateringa observed. Past dates 404.

This endpoint is the slowest (~400 ms) because of the nutrition + ingredients
payload. Throttle accordingly.

---

## 5. Promo codes & promotions

There is no anonymous "list all coupons" endpoint — `/api/profile/coupons-search`
returns 401 without login. Promo codes are surfaced through several feeds:

### `companyHeader.activePromotionInfo` (in `/constant`)

The cleanest source. Per-company, per-city. Fields: `code`, `discountPercents`,
`promoDeadline` (`YYYY-MM-DD`), `promoText`, `separate`. `null` everywhere
when there's no active promo.

### `searchData[].activePromotionInfo` (in `/awarded-and-top`)

Same shape. Lets you discover every company's promo in a city in one paginated
sweep without fetching `/constant` per company.

### `GET /api/open/mobile/banners?cId={cityId}`

City-scoped marketing banners. Each banner has:

```jsonc
{
  "name": "ROBIM30",
  "code": "ROBIM30", // promo code string (or campaign name)
  "url": "https://ml-assets.com/images/...", // banner image
  "validFrom": "2026-04-13T09:30:00+02:00",
  "validTo": "2026-04-26T23:59:00+02:00",
  "deepLink": "dietly://mobile/catering-dietetyczny-firma/robinfood",
  "target": "DASHBOARD", // DASHBOARD / SAVED_MEALS / COMPANIES
  "priority": 1, // lower = shown first
  "type": "CAMPAIGN", // CAMPAIGN / STANDALONE
}
```

`type=CAMPAIGN` banners typically carry redeemable codes. `type=STANDALONE`
are referral / generic programme cards (`PACZKI`, `REFERRAL`).

### `GET /api/open/content-management/recommended-diets?cId={cityId}&page=0&pageSize=5`

Hand-curated dashboard list. Each entry has `activePromotion.code` plus
enough company/diet IDs to drive a price quote:

```jsonc
{
  "companyData":   { "companyId": "twojemenu", "companyName": "Twoje Menu", "awarded": false, ... },
  "dietDetails":   { "dietId": 7, "dietName": "Twoje Menu Basic | Odchudzająca 5 posiłków",
                     "tierId": 1, "dietOptionId": 8, "tierDietOptionId": "1-8",
                     "menuConfiguration": true },
  "feedbackMetrics": { "avgScore": 92, "feedbackValue": 4.88, "feedbackNumber": 1200 },
  "pricingData":   { "minDietPrice": 67.94, "priceCategory": "CHEAP" },
  "activePromotion": {
    "promoText": "Promocja -25%  KOD:WIOSNA",
    "promoDeadline": "2026-04-27",
    "code": "WIOSNA",
    "discountPercents": 25
  }
}
```

### Validating a discovered code

Pass it through `quick-order/calculate-price`. If the code is invalid the
`totalPromoCodeDiscount` stays `0` and the price is unchanged; if valid, you
see the discount math (and `totalLowest30DaysCostWithoutDiscounts` populates
with the Omnibus reference).

---

## 6. Reference / supporting

### `GET /api/open/diet-tag-info?dietTagId={tag}` and `GET /api/mobile/open/diet-tag-info?dietTagId={tag}`

Marketing copy for a diet tag. `tag` values observed:
`STANDARD`, `SPORT`, `LOW IG`, `LOW CARB`, `HOME`, `GLUTEN LACTOSE FREE`,
`DASH`. URL-encode spaces as `%20` (web variant) or `+` (mobile variant) —
both work.

```jsonc
{
  "dietTagInfoId": 2,
  "dietTagId": "STANDARD",
  "name": "Standardowa",
  "locativeName": "Standardowej",
  "additionalName": "dieta standard",
  "calories": [1200, 1500, 1800, 2000, 2500], // typical kcal options
  "main": true,
  "priority": 1,
  "urlName": "standardowa",
  "imageUrl": "https://miscellaneous-images.s3.eu-central-1.amazonaws.com/dietly-diets/STANDARD.jpg",
  "dietTagBulletPoints": ["...", "...", "..."],
  "dietDescriptions": [{ "title": "...", "description": "..." }],
}
```

Other tag values appear in `companyDiets[].dietTag`: `MENU_CONFIGURATION`,
`KETO`, `VEGE`, `VEGETARIAN`, `WEIGHT LOSS`, `LACTOSE FREE` — but they aren't
all valid as `dietTagInfo` queries. There is no "list all tags" endpoint;
just collect the distinct `dietTag` values seen across `/constant` responses.

### `GET /api/mobile/open/possible-side-orders?withCustomDates=true`

Catalogue-wide side-orders (cross-company defaults).

```jsonc
[
  {
    "possibleSideOrderId": 21,
    "name": "Dodatkowy obiad w wariancie klasycznym",
    "description": "ok. 500-600 kcal",
    "defaultPrice": 18.9,
    "minQuantity": 1,
    "maxQuantity": 100,
    "limitedByMaximumSelectedMeals": true,
    "customDates": false,
    "type": "DEFAULT",
  },
]
```

Per-company side-orders live under `companySideOrders` in the `/constant`
response (different shape: `id.courseAsSideOrderId`, `imageUrl`, ratings).

### Order-form helpers (mostly UI config — listed for completeness)

- `GET /api/mobile/open/form-settings`
- `GET /api/mobile/open/order-form/form-settings`
- `GET /api/mobile/open/order-form/diet-details?cityId={cityId}`
- `GET /api/mobile/open/order-form/steps/calendar?dietCaloriesId={dietCaloriesId}`
- `GET /api/mobile/open/order-form/steps/side-orders`
- `GET /api/mobile/open/settings/form/shopping-cart`

### Dashboard CMS

- `GET /api/open/content-management/interface/DASHBOARD?cId={cityId}` — section
  layout for the app dashboard.
- `GET /api/open/content-management/user-stories` — testimonial cards.

Useful only if you want to mirror what the app shows; not needed for the
diet/price/menu/promo scrape.

---

## 7. Observed IDs (Wrocław capture)

- City: `986283` (Wrocław). Other top-10: `918123` Warszawa, `933016` Gdańsk,
  `950463` Kraków, `957650` Łódź, `964465` Olsztyn, `969400` Poznań,
  `977976` Szczecin, `922410` Białystok, `934100` Gdynia.
- Companies: `robinfood`, `mangodiet` (full HAR coverage). 152 companies are
  available in Wrocław per `awarded-and-top`.
- robinfood diets: `4` (Wybór menu, menu-config) + `9, 7, 10, 8, 12, 11, 13`
  (fixed). 6 tiers under dietId=4: `5, 6, 7, 8, 10, 11`. `dietCaloriesId`
  range 65–146 + 184/187 (2200 kcal additions).
- Active promo codes seen: `MG30` (mangodiet, -30%, deadline 2026-05-03,
  separate=true), `ROBIM30` (robinfood, -30%, deadline 2026-04-26),
  `MASZWIĘCEJ` (simplebox, -33%, deadline 2026-05-15), `WIOSNA` (twojemenu,
  -25%, deadline 2026-04-27).

---

## 8. Failures / gotchas

- `GET /api/profile/coupons-search` → 401. Do not depend on it.
- Prices in `/city/{cityId}` and `companyDiets[].dietTiers[].minPrice` are
  formatted strings (`"67.00 zł"`). The `/calculate-price` responses use
  numeric floats. Don't compare them without parsing.
- `dietPriceInCompanyPromotion: true` in `/city` does **not** mean the promo
  is auto-applied to anonymous quotes. Some promos (`separate: true`, like
  `MG30`) require passing the code via `promoCodes`.
- `menuDaysAhead` is per-company. Quering past `today + menuDaysAhead` on the
  menu endpoint returns 404 / empty.
- Some companies have `companyHeader.activePromotionInfo` all-null even when
  `awarded-and-top` lists a promo for them — refresh from both sources.
- The `awarded-and-top` `searchData[].name` is the slug, **`fullName`** is the
  display name; don't confuse them.
- The mobile menu endpoint is slow (~400 ms). With `menuDaysAhead=18` and ~7
  kcal levels per fixed diet, a full menu sweep is hundreds of requests per
  company. Be selective about which leaves you fetch (e.g. one canonical kcal
  level per diet for daily snapshots).

---

## 9. Scraping playbook

1. **City** → `top-search?query=...` → `cityId`.
2. **Companies** → `awarded-and-top?cId={cityId}&rV=V2023_1&pageSize=50&page=0..N`
   until `currentPage == totalPages-1`. Already gives you ratings, params,
   `priceCategory`, and `activePromotionInfo` for every company in town.
3. **Per company catalog** → `company-card/{companyId}/constant?cityId={cityId}`
   for the diet/tier/option/kcal tree, plus `company-card/{companyId}/city/{cityId}`
   for advertised prices.
4. **True prices** → for every leaf `dietCaloriesId` (with `tierDietOptionId`
   for menu-config diets): `POST quick-order/calculate-price` with
   `deliveryDates=[today+1, ...]`. Use a fixed length (e.g. 10 weekdays) so
   discounts are comparable across companies.
5. **Daily menus** → for the `dietCaloriesId` levels you care about:
   `menu/{dietCaloriesId}/city/{cityId}/date/{YYYY-MM-DD}` for each day in
   `[today, today+menuDaysAhead]`. Persist by `(date, dietCaloriesId, dietCaloriesMealId)`.
6. **Promo codes** → union of `companyHeader.activePromotionInfo`,
   `awarded-and-top.searchData[].activePromotionInfo`, banners
   (`/api/open/mobile/banners?cId=`), and `recommended-diets`. Validate by
   round-tripping through `quick-order/calculate-price`.
