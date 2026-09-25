import { NextResponse } from "next/server";

import { getPriceHistory } from "@/lib/queries";

export const dynamic = "force-dynamic";

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Next.js route handler signature requires Web standard Request; cannot be made deeply readonly
export const GET = async (request: Request) => {
  const { searchParams } = new URL(request.url);
  const companyId = searchParams.get("company_id");
  const dietCaloriesId = Number(searchParams.get("diet_calories_id"));
  const cityId = Number(searchParams.get("city_id"));
  const days = Number(searchParams.get("days"));
  // Needed for menu-configuration diets, whose tiers share one
  // diet_calories_id; optional otherwise.
  const tierParam = searchParams.get("tier_id");
  const tierId = tierParam === null ? null : Number(tierParam);

  if (
    companyId === null ||
    companyId === "" ||
    !Number.isFinite(dietCaloriesId) ||
    !Number.isFinite(cityId) ||
    !Number.isFinite(days) ||
    (tierId !== null && !Number.isInteger(tierId))
  ) {
    return NextResponse.json({ error: "bad params" }, { status: 400 });
  }

  try {
    const history = await getPriceHistory({
      cityId,
      companyId,
      days,
      dietCaloriesId,
      tierId,
    });
    return NextResponse.json({ history });
  } catch (error) {
    console.error("[price-history] query failed", error);
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }
};
