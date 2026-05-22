import { NextResponse } from "next/server";

import { toViewDay } from "@/lib/match-types";
import { getWeekView } from "@/lib/queries";
import type { SortId } from "@/lib/sort-metrics";

const VALID_SORTS: ReadonlySet<SortId> = new Set<SortId>([
  "carbs-asc",
  "fat-asc",
  "fiber-desc",
  "fiber-per-zl",
  "kcal-per-zl",
  "price-asc",
  "protein-desc",
  "protein-per-zl",
  "review-desc",
  "review-per-zl",
  "score-desc",
  "score-per-zl",
]);

const parseSort = (raw: string | null): SortId | undefined => {
  if (raw === null || raw === "") {
    return undefined;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed by VALID_SORTS membership
  return VALID_SORTS.has(raw as SortId) ? (raw as SortId) : undefined;
};

export const dynamic = "force-dynamic";

const parseIntOr = (raw: string | null, fallback: number): number => {
  if (raw === null || raw === "") {
    return fallback;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
};

const parseList = (raw: string | null): string[] => {
  if (raw === null || raw === "") {
    return [];
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
};

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Next.js route handler signature requires Web standard Request
export const GET = async (request: Request) => {
  const { searchParams } = new URL(request.url);
  const cityId = parseIntOr(searchParams.get("city_id"), Number.NaN);
  if (!Number.isFinite(cityId)) {
    return NextResponse.json({ error: "bad city_id" }, { status: 400 });
  }

  const dates = parseList(searchParams.get("dates"));
  if (dates.length === 0) {
    return NextResponse.json({ error: "dates required" }, { status: 400 });
  }

  const prefer = parseList(searchParams.get("prefer"));
  const avoid = parseList(searchParams.get("avoid"));
  const excludeCompanyIds = parseList(searchParams.get("exclude"));
  const includeCompanyIds = parseList(searchParams.get("include"));
  const kcalMinRaw = searchParams.get("kcal_min");
  const kcalMaxRaw = searchParams.get("kcal_max");
  const kcalMin =
    kcalMinRaw === null ? undefined : parseIntOr(kcalMinRaw, Number.NaN);
  const kcalMax =
    kcalMaxRaw === null ? undefined : parseIntOr(kcalMaxRaw, Number.NaN);
  const orderDaysRaw = searchParams.get("order_days");
  const orderDays =
    orderDaysRaw === null ? undefined : parseIntOr(orderDaysRaw, 5);
  // Per-day top-N cap. The home page's two-phase loader uses `1` for the
  // fast first-paint table and omits the param (= 0 = no cap) for the
  // per-day lazy fetch that powers the expanded-row scatter.
  const limitRaw = searchParams.get("limit");
  const limit = limitRaw === null ? 0 : parseIntOr(limitRaw, 0);
  const sort = parseSort(searchParams.get("sort"));

  try {
    const weekView = await getWeekView({
      avoid,
      cityId,
      dates,
      excludeCompanyIds,
      includeCompanyIds,
      kcalMax: Number.isFinite(kcalMax) ? kcalMax : undefined,
      kcalMin: Number.isFinite(kcalMin) ? kcalMin : undefined,
      limit,
      orderDays,
      prefer,
      sort,
    });
    const days = weekView.map(toViewDay);
    return NextResponse.json({ days });
  } catch (error) {
    console.error("[match-week] query failed", error);
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }
};
