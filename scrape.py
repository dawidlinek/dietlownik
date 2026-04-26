"""Collect diet/price catalog from dietly.pl for a given city.

Usage:
    python scrape.py "Wrocław" --days 10 --out wroclaw.json

The script:
  1. resolves the city via /api/open/search/top-search
  2. discovers companies (top-search with companiesSize=200)
  3. for each company, fetches /constant and /city endpoints
  4. quotes /calculate-price for every (diet, tier, option, kcal) leaf
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import time
import urllib.parse
from typing import Iterator

import requests

BASE = "https://dietly.pl"
HEADERS = {
    "accept": "application/json",
    "accept-language": "pl,en;q=0.9",
    "user-agent": "Mozilla/5.0 (compatible; dietlownik/0.1; +personal-research)",
}


def get(session: requests.Session, path: str, **params) -> dict:
    r = session.get(BASE + path, params=params or None, headers=HEADERS, timeout=20)
    r.raise_for_status()
    return r.json()


def post(session: requests.Session, path: str, body: dict) -> dict:
    r = session.post(BASE + path, json=body, headers=HEADERS, timeout=20)
    r.raise_for_status()
    return r.json()


def resolve_city(session, name: str) -> dict:
    data = get(
        session,
        "/api/open/search/top-search",
        query=name,
        citiesSize=10,
        companiesSize=0,
    )
    cities = [c for c in data["cities"] if c.get("cityStatus")]
    if not cities:
        raise SystemExit(f"no supported city matched {name!r}")
    cities.sort(key=lambda c: -c["numberOfCompanies"])
    return cities[0]


def list_companies(session, city_name: str) -> list[dict]:
    """Fetches companies via top-search. Inferred from response shape — verify
    with a small companiesSize first run if you're being cautious."""
    data = get(
        session,
        "/api/open/search/top-search",
        query=city_name,
        citiesSize=0,
        companiesSize=200,
    )
    return data.get("companies") or []


def company_constant(session, company_id: str, city_id: int) -> dict:
    return get(
        session,
        f"/api/dietly/open/company-card/{company_id}/constant",
        cityId=city_id,
    )


def company_city_summary(session, company_id: str, city_id: int) -> dict:
    return get(
        session,
        f"/api/dietly/open/company-card/{company_id}/city/{city_id}",
    )


def calc_price(
    session,
    company_id: str,
    *,
    city_id: int,
    diet_calories_id: int,
    delivery_dates: list[str],
    tier_diet_option_id: str | None = None,
    promo_codes: list[str] | None = None,
) -> dict:
    body = {
        "promoCodes": promo_codes or [],
        "deliveryDates": delivery_dates,
        "dietCaloriesId": diet_calories_id,
        "testOrder": False,
        "cityId": city_id,
    }
    if tier_diet_option_id:
        body["tierDietOptionId"] = tier_diet_option_id
    return post(
        session,
        f"/api/dietly/open/company-card/{company_id}/quick-order/calculate-price",
        body,
    )


def consecutive_dates(n: int, start: dt.date | None = None) -> list[str]:
    """N consecutive calendar days starting tomorrow by default. The price API
    accepts non-business days as long as the company delivers on them — but if
    you want strict business days, filter here against deliveryOnSaturday /
    deliveryOnSunday from companyParams."""
    start = start or (dt.date.today() + dt.timedelta(days=1))
    return [(start + dt.timedelta(days=i)).isoformat() for i in range(n)]


def iter_leaves(constant: dict) -> Iterator[dict]:
    """Yield every quotable leaf — one per (diet, tier, option, kcal). For
    ready (non-tiered) diets, falls back to (dietId, kcal) only — but in this
    HAR every diet had tiers populated through the constant endpoint, so the
    common case is fully qualified."""
    for diet in constant.get("companyDiets", []):
        diet_id = diet["dietId"]
        diet_name = diet["name"]
        diet_tag = diet.get("dietTag")
        is_menu = diet.get("isMenuConfiguration", False)
        tiers = diet.get("dietTiers") or []
        if not tiers:
            yield {
                "dietId": diet_id,
                "dietName": diet_name,
                "dietTag": diet_tag,
                "isMenuConfiguration": is_menu,
                "tierId": None,
                "tierName": None,
                "tierDietOptionId": None,
                "dietOptionId": None,
                "dietOptionName": None,
                "dietCaloriesId": None,
                "calories": None,
            }
            continue
        for tier in tiers:
            for option in tier.get("dietOptions", []):
                for cal in option.get("dietCalories", []):
                    yield {
                        "dietId": diet_id,
                        "dietName": diet_name,
                        "dietTag": diet_tag,
                        "isMenuConfiguration": is_menu,
                        "tierId": tier["tierId"],
                        "tierName": tier["name"],
                        "tierDietOptionId": option["tierDietOptionId"],
                        "dietOptionId": option["dietOptionId"],
                        "dietOptionName": option["name"],
                        "dietCaloriesId": cal["dietCaloriesId"],
                        "calories": cal["calories"],
                    }


def quote_company(
    session,
    company: dict,
    city_id: int,
    days: int,
    promo_codes: list[str],
    sleep: float,
) -> dict:
    company_id = company["companyId"] if "companyId" in company else company["sanitizedName"]
    constant = company_constant(session, company_id, city_id)
    summary = company_city_summary(session, company_id, city_id)
    dates = consecutive_dates(days)
    quotes = []
    for leaf in iter_leaves(constant):
        if leaf["dietCaloriesId"] is None:
            continue
        try:
            price = calc_price(
                session,
                company_id,
                city_id=city_id,
                diet_calories_id=leaf["dietCaloriesId"],
                delivery_dates=dates,
                tier_diet_option_id=leaf["tierDietOptionId"] if leaf["isMenuConfiguration"] else None,
                promo_codes=promo_codes,
            )
        except requests.HTTPError as e:
            print(f"  ! {company_id} {leaf['dietName']} {leaf['calories']}kcal: {e}", file=sys.stderr)
            continue
        item = price["items"][0] if price.get("items") else {}
        quotes.append(
            {
                **leaf,
                "perDay": item.get("perDayDietCost"),
                "perDayWithDiscount": item.get("perDayDietWithDiscountsCost"),
                "total": price["cart"]["totalCostToPay"],
                "totalWithoutDiscount": price["cart"]["totalCostWithoutDiscounts"],
                "deliveryCost": price["cart"]["totalDeliveryCost"],
            }
        )
        time.sleep(sleep)
    return {
        "companyId": company_id,
        "companyName": constant.get("companyHeader", {}).get("name"),
        "rate": constant.get("companyHeader", {}).get("rate"),
        "feedbackNumber": constant.get("companyHeader", {}).get("feedbackNumber"),
        "lowestPrice": summary.get("lowestPrice"),
        "companyPriceCategory": summary.get("companyPriceCategory"),
        "deliveryOnSaturday": constant.get("companyParams", {}).get("deliveryOnSaturday"),
        "deliveryOnSunday": constant.get("companyParams", {}).get("deliveryOnSunday"),
        "quotes": quotes,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("city", help='city name, e.g. "Wrocław"')
    ap.add_argument("--days", type=int, default=10)
    ap.add_argument("--promo", action="append", default=[])
    ap.add_argument("--out", default="-")
    ap.add_argument("--sleep", type=float, default=0.3)
    ap.add_argument("--limit", type=int, default=None, help="cap company count for testing")
    ap.add_argument(
        "--companies",
        nargs="*",
        default=None,
        help="explicit companyId list (skips discovery)",
    )
    args = ap.parse_args()

    session = requests.Session()

    city = resolve_city(session, args.city)
    print(f"city: {city['name']} (cityId={city['cityId']}, {city['numberOfCompanies']} companies)", file=sys.stderr)

    if args.companies:
        companies = [{"companyId": cid, "sanitizedName": cid} for cid in args.companies]
    else:
        companies = list_companies(session, city["name"])
        print(f"discovered {len(companies)} companies", file=sys.stderr)

    if args.limit:
        companies = companies[: args.limit]

    out = []
    for i, c in enumerate(companies, 1):
        cid = c.get("companyId") or c.get("sanitizedName")
        print(f"[{i}/{len(companies)}] {cid}", file=sys.stderr)
        try:
            out.append(quote_company(session, c, city["cityId"], args.days, args.promo, args.sleep))
        except requests.HTTPError as e:
            print(f"  ! {cid}: {e}", file=sys.stderr)

    payload = {"city": city, "days": args.days, "promoCodes": args.promo, "companies": out}
    if args.out == "-":
        json.dump(payload, sys.stdout, indent=2, ensure_ascii=False)
    else:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, ensure_ascii=False)
        print(f"wrote {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
