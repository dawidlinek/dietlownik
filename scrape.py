"""Scrape diets / prices / menus / promotions from dietly.pl (mobile API).

Usage examples:
    python scrape.py "Wrocław" --out wroclaw.json
    python scrape.py "Warszawa" --order-days 10 --menu-days 14 --out warszawa.json
    python scrape.py "Wrocław" --companies robinfood mangodiet --out wroclaw_sample.json

Snapshot shape (one JSON file):
    {
      "snapshotDate": "2026-04-26",
      "city": { "cityId": ..., "name": "..." },
      "companies": [
        {
          "companyId": "...",
          "fullName": "...", "rate": ..., "priceCategory": "...",
          "activePromotionInfo": { ... },        # from awarded-and-top
          "constant": { ... },                   # /constant response (full)
          "cityCard": { ... },                   # /city/{cityId} response
          "leaves": [                            # one entry per (diet, [tier], option, kcal)
            {
              "dietId": ..., "dietName": "...", "dietTag": "...", "isMenuConfiguration": true,
              "tierId": ..., "tierName": "...", "tierMealsNumber": ...,
              "dietOptionId": ..., "dietOptionName": "...", "dietOptionTag": "...",
              "tierDietOptionId": "6-15",
              "dietCaloriesId": 65, "calories": 1200,
              "advertised": { "discountPrice": "62.00 zł", "defaultPrice": "62.00 zł", "inPromotion": false },
              "quote": {                          # from /quick-order/calculate-price
                "deliveryDates": [...],
                "totalCostToPay": 670.00,
                "totalCostWithoutDiscounts": 670.00,
                "totalLowest30DaysCostWithoutDiscounts": null,
                "totalPromoCodeDiscount": 0.00,
                "totalOrderLengthDiscount": 0.00,
                "perDayWithDiscounts": 67.00,
                "promoCodes": [],
                "error": null
              }
            }
          ],
          "menus": [                              # only fetched for menu-config diets by default
            {
              "dietCaloriesId": 65, "tierId": 6, "calories": 1200,
              "days": [ { "date": "2026-04-26", "meals": [...] }, ... ]
            }
          ]
        }
      ],
      "promotions": {
        "byCompany": [ { "companyId": "...", "code": "...", "discountPercents": 30, "deadline": "...", "source": "constant|awarded-and-top|recommended-diets" } ],
        "banners": [ ... ],                       # raw /api/open/mobile/banners
        "recommendedDiets": [ ... ]               # raw /api/open/content-management/recommended-diets
      }
    }

To track menus over time, run this on a schedule and diff snapshots by
(companyId, date, dietCaloriesId, dietCaloriesMealId).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import time
from typing import Any

import requests

BASE = "https://aplikacja.dietly.pl"
HEADERS = {
    "content-type": "application/json",
    "accept": "application/json",
    "accept-language": "pl-PL",
    "x-launcher-type": "ANDROID_APP",
    "x-mobile-version": "4.0.0",
    "user-agent": "okhttp/4.9.2",
}


class DietlyClient:
    def __init__(self, throttle_s: float = 0.4, timeout_s: float = 25.0):
        self.session = requests.Session()
        self.session.headers.update(HEADERS)
        self.throttle_s = throttle_s
        self.timeout_s = timeout_s

    def _sleep(self) -> None:
        if self.throttle_s > 0:
            time.sleep(self.throttle_s)

    def get(self, path: str, *, company_id: str | None = None, **params: Any) -> Any:
        params = {k: v for k, v in params.items() if v is not None}
        headers = {"company-id": company_id} if company_id else {}
        r = self.session.get(
            BASE + path, params=params or None, headers=headers, timeout=self.timeout_s
        )
        self._sleep()
        r.raise_for_status()
        return r.json()

    def post(self, path: str, body: dict, company_id: str | None = None) -> Any:
        headers = {"company-id": company_id} if company_id else {}
        r = self.session.post(BASE + path, json=body, headers=headers, timeout=self.timeout_s)
        self._sleep()
        r.raise_for_status()
        return r.json()

    # ---- discovery ----

    def resolve_city(self, name: str) -> dict:
        data = self.get(
            "/api/open/search/top-search",
            query=name,
            citiesSize=10,
            companiesSize=0,
        )
        for city in data.get("cities") or []:
            if city["name"].lower() == name.lower() or city["sanitizedName"] == name.lower():
                return city
        if data.get("cities"):
            return data["cities"][0]
        raise SystemExit(f"No city matched {name!r}")

    def list_companies(self, city_id: int, page_size: int = 50) -> list[dict]:
        out: list[dict] = []
        page = 0
        while True:
            data = self.get(
                "/api/open/search/full/awarded-and-top",
                cId=city_id,
                rV="V2023_1",
                pageSize=page_size,
                page=page,
                active="",
            )
            out.extend(data.get("searchData") or [])
            total_pages = data.get("totalPages") or 1
            page += 1
            if page >= total_pages:
                break
        return out

    # ---- per-company ----

    def company_constant(self, company_id: str, city_id: int) -> dict:
        return self.get(
            f"/api/mobile/open/company-card/{company_id}/constant",
            company_id=company_id,
            cityId=city_id,
        )

    def company_city_card(self, company_id: str, city_id: int) -> dict:
        return self.get(
            f"/api/mobile/open/company-card/{company_id}/city/{city_id}",
            company_id=company_id,
        )

    def quick_order_price(
        self,
        company_id: str,
        city_id: int,
        diet_calories_id: int,
        delivery_dates: list[str],
        tier_diet_option_id: str | None = None,
        promo_codes: list[str] | None = None,
    ) -> dict:
        body: dict[str, Any] = {
            "cityId": city_id,
            "deliveryDates": list(delivery_dates),
            "dietCaloriesId": diet_calories_id,
            "promoCodes": list(promo_codes) if promo_codes else [""],
            "testOrder": False,
        }
        if tier_diet_option_id is not None:
            body["tierDietOptionId"] = tier_diet_option_id
        return self.post(
            f"/api/mobile/open/company-card/{company_id}/quick-order/calculate-price",
            body,
            company_id=company_id,
        )

    def menu(
        self,
        company_id: str,
        diet_calories_id: int,
        city_id: int,
        date: str,
        tier_id: int | None = None,
    ) -> dict:
        path = f"/api/mobile/open/company-card/{company_id}/menu/{diet_calories_id}/city/{city_id}/date/{date}"
        return self.get(path, company_id=company_id, tierId=tier_id)

    # ---- promotion feeds ----

    def banners(self, city_id: int) -> list[dict]:
        return self.get("/api/open/mobile/banners", cId=city_id)

    def recommended_diets(self, city_id: int, page_size: int = 20) -> list[dict]:
        return self.get(
            "/api/open/content-management/recommended-diets",
            cId=city_id,
            page=0,
            pageSize=page_size,
        )


# ---- catalog walking ----

def iter_leaves(constant: dict):
    """Yield (diet, tier|None, option, kcal) for every leaf in /constant."""
    for diet in constant.get("companyDiets") or []:
        if diet.get("isMenuConfiguration") and diet.get("dietTiers"):
            for tier in diet["dietTiers"]:
                for option in tier.get("dietOptions") or []:
                    for kcal in option.get("dietCalories") or []:
                        yield diet, tier, option, kcal
        else:
            for option in diet.get("dietOptions") or []:
                for kcal in option.get("dietCalories") or []:
                    yield diet, None, option, kcal


# ---- date helpers ----

def weekday_dates(start: dt.date, count: int, include_weekends: bool = True) -> list[str]:
    """Return `count` consecutive future calendar dates starting at `start`."""
    out: list[str] = []
    d = start
    while len(out) < count:
        if include_weekends or d.weekday() < 5:
            out.append(d.isoformat())
        d += dt.timedelta(days=1)
    return out


# ---- quote / menu collectors ----

def collect_leaves(
    client: DietlyClient,
    company_id: str,
    city_id: int,
    constant: dict,
    city_card: dict,
    delivery_dates: list[str],
    promo_codes: list[str] | None,
) -> list[dict]:
    advertised_by_id: dict[int, dict] = {}
    for entry in city_card.get("dietPriceInfo") or []:
        for cid in entry.get("dietCaloriesIds") or []:
            advertised_by_id[cid] = {
                "discountPrice": entry.get("discountPrice"),
                "defaultPrice": entry.get("defaultPrice"),
                "inPromotion": entry.get("dietPriceInCompanyPromotion"),
            }

    leaves: list[dict] = []
    for diet, tier, option, kcal in iter_leaves(constant):
        diet_calories_id = kcal["dietCaloriesId"]
        tier_diet_option_id = (
            f"{tier['tierId']}-{option['dietOptionId']}" if tier else None
        )
        leaf = {
            "dietId": diet["dietId"],
            "dietName": diet["name"],
            "dietTag": diet.get("dietTag"),
            "isMenuConfiguration": diet.get("isMenuConfiguration", False),
            "tierId": tier["tierId"] if tier else None,
            "tierName": tier["name"] if tier else None,
            "tierMealsNumber": tier.get("mealsNumber") if tier else None,
            "dietOptionId": option["dietOptionId"],
            "dietOptionName": option["name"],
            "dietOptionTag": option.get("dietOptionTag"),
            "tierDietOptionId": tier_diet_option_id,
            "dietCaloriesId": diet_calories_id,
            "calories": kcal["calories"],
            "advertised": advertised_by_id.get(diet_calories_id),
        }
        try:
            quote = client.quick_order_price(
                company_id=company_id,
                city_id=city_id,
                diet_calories_id=diet_calories_id,
                delivery_dates=delivery_dates,
                tier_diet_option_id=tier_diet_option_id,
                promo_codes=promo_codes,
            )
            cart = quote.get("cart", {})
            items = quote.get("items") or [{}]
            leaf["quote"] = {
                "deliveryDates": delivery_dates,
                "totalCostToPay": cart.get("totalCostToPay"),
                "totalCostWithoutDiscounts": cart.get("totalCostWithoutDiscounts"),
                "totalLowest30DaysCostWithoutDiscounts": cart.get(
                    "totalLowest30DaysCostWithoutDiscounts"
                ),
                "totalPromoCodeDiscount": cart.get("totalPromoCodeDiscount"),
                "totalOrderLengthDiscount": cart.get("totalOrderLengthDiscount"),
                "totalDeliveryCost": cart.get("totalDeliveryCost"),
                "perDayWithDiscounts": items[0].get("perDayDietWithDiscountsCost"),
                "perDay": items[0].get("perDayDietCost"),
                "promoCodes": list(promo_codes or []),
                "error": None,
            }
        except requests.HTTPError as e:
            leaf["quote"] = {
                "deliveryDates": delivery_dates,
                "error": f"HTTP {e.response.status_code}",
                "promoCodes": list(promo_codes or []),
            }
        leaves.append(leaf)
    return leaves


def collect_menus(
    client: DietlyClient,
    company_id: str,
    city_id: int,
    constant: dict,
    menu_days: int,
    start_date: dt.date,
    only_menu_config: bool,
) -> list[dict]:
    """Fetch menus for one canonical kcal level per (diet, tier, option).

    Different kcal levels under the same option serve the same dishes with
    different portion sizes, so fetching the lowest kcal is enough to track
    which dishes appear on which day.
    """
    days_ahead = constant.get("menuSettings", {}).get("menuDaysAhead") or 0
    if not constant.get("menuSettings", {}).get("menuEnabled") or not days_ahead:
        return []
    days_to_fetch = min(menu_days, days_ahead)
    dates = weekday_dates(start_date, days_to_fetch)

    targets: list[dict] = []
    seen: set[tuple[int | None, int]] = set()
    for diet, tier, option, kcal in iter_leaves(constant):
        if only_menu_config and not diet.get("isMenuConfiguration"):
            continue
        key = (tier["tierId"] if tier else None, option["dietOptionId"])
        if key in seen:
            continue
        seen.add(key)
        targets.append({
            "dietId": diet["dietId"],
            "dietName": diet["name"],
            "tierId": tier["tierId"] if tier else None,
            "tierName": tier["name"] if tier else None,
            "dietOptionId": option["dietOptionId"],
            "dietOptionName": option["name"],
            "dietCaloriesId": kcal["dietCaloriesId"],
            "calories": kcal["calories"],
        })

    out: list[dict] = []
    for t in targets:
        days = []
        for date in dates:
            try:
                payload = client.menu(
                    company_id, t["dietCaloriesId"], city_id, date, tier_id=t["tierId"]
                )
                days.append(_compact_menu_day(payload))
            except requests.HTTPError as e:
                days.append({"date": date, "error": f"HTTP {e.response.status_code}"})
        out.append({**t, "days": days})
    return out


def _compact_menu_day(payload: dict) -> dict:
    """Flatten the menu response to keep snapshots diff-friendly."""
    meals = []
    for meal in payload.get("meals") or []:
        options = []
        for opt in meal.get("options") or []:
            details = opt.get("details") or {}
            options.append({
                "dietCaloriesMealId": opt.get("dietCaloriesMealId"),
                "name": opt.get("name"),
                "label": opt.get("label"),
                "info": opt.get("info"),
                "thermo": opt.get("thermo"),
                "reviewsScore": opt.get("reviewsScore"),
                "reviewsNumber": opt.get("reviewsNumber"),
                "imageUrl": details.get("imageUrl"),
                "macros": {
                    "calories": details.get("calories"),
                    "protein": details.get("protein"),
                    "carbohydrate": details.get("carbohydrate"),
                    "fat": details.get("fat"),
                    "fiber": details.get("dietaryFiber"),
                    "sugar": details.get("sugar"),
                    "saturatedFat": details.get("saturatedFattyAcids"),
                    "salt": details.get("salt"),
                },
                "allergens": [
                    a.get("dietlyAllergenName")
                    for a in (details.get("allergensWithExcluded") or [])
                ],
                "ingredients": [i.get("name") for i in (details.get("ingredients") or [])],
            })
        meals.append({
            "name": meal.get("name"),
            "baseDietCaloriesMealId": meal.get("baseDietCaloriesMealId"),
            "options": options,
        })
    return {"date": payload.get("date"), "calories": payload.get("calories"), "meals": meals}


# ---- promotion aggregator ----

def gather_promotions(
    companies_summary: list[dict],
    company_results: list[dict],
    banners: list[dict],
    recommended: list[dict],
) -> dict:
    by_company: dict[tuple[str, str], dict] = {}

    def add(source: str, company_id: str | None, info: dict | None):
        if not company_id or not info:
            return
        code = info.get("code")
        if not code:
            return
        key = (company_id, code)
        existing = by_company.get(key)
        record = {
            "companyId": company_id,
            "code": code,
            "discountPercents": info.get("discountPercents"),
            "deadline": info.get("promoDeadline"),
            "promoText": info.get("promoText"),
            "separate": info.get("separate"),
            "sources": [source],
        }
        if existing:
            existing["sources"] = sorted(set(existing["sources"] + [source]))
        else:
            by_company[key] = record

    for c in companies_summary:
        add("awarded-and-top", c.get("name"), c.get("activePromotionInfo"))

    for c in company_results:
        cid = c.get("companyId")
        header = (c.get("constant") or {}).get("companyHeader") or {}
        add("constant", cid, header.get("activePromotionInfo"))

    for r in recommended or []:
        cid = (r.get("companyData") or {}).get("companyId")
        add("recommended-diets", cid, r.get("activePromotion"))

    return {
        "byCompany": list(by_company.values()),
        "banners": banners,
        "recommendedDiets": recommended,
    }


# ---- main ----

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Scrape dietly.pl for a city.")
    parser.add_argument("city", help="City name, e.g. 'Wrocław'")
    parser.add_argument("--out", required=True, help="Output JSON path")
    parser.add_argument(
        "--order-days",
        type=int,
        default=10,
        help="How many delivery days to use for the price quote (default 10).",
    )
    parser.add_argument(
        "--menu-days",
        type=int,
        default=7,
        help="How many days of menu to fetch per kcal target (default 7).",
    )
    parser.add_argument(
        "--companies",
        nargs="*",
        help="Limit to a specific list of companyId slugs (default: all in city).",
    )
    parser.add_argument(
        "--no-menus",
        action="store_true",
        help="Skip menu fetching (fast catalog/price snapshot only).",
    )
    parser.add_argument(
        "--menus-all-diets",
        action="store_true",
        help="Fetch menus for fixed (non-menu-config) diets too. Default is menu-config only.",
    )
    parser.add_argument(
        "--throttle",
        type=float,
        default=0.35,
        help="Sleep seconds between requests (default 0.35).",
    )
    parser.add_argument(
        "--promo-code",
        action="append",
        default=[],
        help="Promo code to attach to all price quotes (repeatable).",
    )
    args = parser.parse_args(argv)

    client = DietlyClient(throttle_s=args.throttle)

    today = dt.date.today()
    delivery_dates = weekday_dates(today + dt.timedelta(days=2), args.order_days)

    print(f"Resolving city: {args.city}", file=sys.stderr)
    city = client.resolve_city(args.city)
    city_id = city["cityId"]
    print(f"  -> cityId={city_id} ({city['name']})", file=sys.stderr)

    print("Listing companies in city…", file=sys.stderr)
    companies_summary = client.list_companies(city_id)
    print(f"  -> {len(companies_summary)} companies", file=sys.stderr)

    if args.companies:
        wanted = set(args.companies)
        companies_summary = [c for c in companies_summary if c.get("name") in wanted]
        print(f"  filtered to {len(companies_summary)}", file=sys.stderr)

    print("Fetching banners + recommended diets…", file=sys.stderr)
    try:
        banners = client.banners(city_id)
    except requests.HTTPError as e:
        print(f"  banners failed: {e}", file=sys.stderr)
        banners = []
    try:
        recommended = client.recommended_diets(city_id)
    except requests.HTTPError as e:
        print(f"  recommended-diets failed: {e}", file=sys.stderr)
        recommended = []

    company_results: list[dict] = []
    for i, summary in enumerate(companies_summary, 1):
        cid = summary.get("name")
        if not cid:
            continue
        print(f"[{i}/{len(companies_summary)}] {cid}", file=sys.stderr)
        try:
            constant = client.company_constant(cid, city_id)
            city_card = client.company_city_card(cid, city_id)
        except requests.HTTPError as e:
            print(f"  catalog fetch failed: {e}", file=sys.stderr)
            continue

        leaves = collect_leaves(
            client=client,
            company_id=cid,
            city_id=city_id,
            constant=constant,
            city_card=city_card,
            delivery_dates=delivery_dates,
            promo_codes=args.promo_code or None,
        )

        menus: list[dict] = []
        if not args.no_menus:
            menus = collect_menus(
                client=client,
                company_id=cid,
                city_id=city_id,
                constant=constant,
                menu_days=args.menu_days,
                start_date=today,
                only_menu_config=not args.menus_all_diets,
            )

        company_results.append({
            "companyId": cid,
            "fullName": summary.get("fullName"),
            "rate": summary.get("rate"),
            "numberOfRates": summary.get("numberOfRates"),
            "priceCategory": summary.get("priceCategory"),
            "awarded": summary.get("awarded"),
            "params": summary.get("params"),
            "activePromotionInfo": summary.get("activePromotionInfo"),
            "constant": constant,
            "cityCard": city_card,
            "leaves": leaves,
            "menus": menus,
        })

    promotions = gather_promotions(companies_summary, company_results, banners, recommended)

    snapshot = {
        "snapshotDate": today.isoformat(),
        "snapshotTimestamp": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "city": {"cityId": city_id, "name": city["name"], "raw": city},
        "queryParams": {
            "orderDays": args.order_days,
            "menuDays": args.menu_days,
            "deliveryDates": delivery_dates,
            "promoCodes": list(args.promo_code or []),
            "menusAllDiets": args.menus_all_diets,
            "noMenus": args.no_menus,
        },
        "companies": company_results,
        "promotions": promotions,
    }

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(snapshot, f, ensure_ascii=False, indent=2)
    print(f"Wrote {args.out}", file=sys.stderr)

    n_days = max(len(delivery_dates), 1)
    cheapest = sorted(
        (
            {
                "companyId": c["companyId"],
                "perDay": (leaf["quote"]["totalCostToPay"] / n_days),
                "diet": leaf["dietName"],
                "tier": leaf["tierName"],
                "option": leaf["dietOptionName"],
                "kcal": leaf["calories"],
            }
            for c in company_results
            for leaf in c["leaves"]
            if (leaf.get("quote") or {}).get("totalCostToPay") is not None
        ),
        key=lambda r: r["perDay"],
    )[:5]
    if cheapest:
        promo = ", ".join(args.promo_code) if args.promo_code else "no promo"
        print(
            f"Cheapest 5 (per-day @ {n_days}-day order, {promo}):",
            file=sys.stderr,
        )
        for row in cheapest:
            print(
                f"  {row['perDay']:>7.2f} zł  {row['companyId']:<20} "
                f"{row['diet']} / {row['tier'] or '-'} / {row['option']} @ {row['kcal']} kcal",
                file=sys.stderr,
            )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
