import { NextResponse } from "next/server";

import { getVariantMeals } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const companyId = searchParams.get("company_id");
  const dietCaloriesId = Number(searchParams.get("diet_calories_id"));
  const tierIdRaw = searchParams.get("tier_id");
  const tierId =
    tierIdRaw === null || tierIdRaw === "" ? null : Number(tierIdRaw);

  if (
    !companyId ||
    !Number.isFinite(dietCaloriesId) ||
    (tierId !== null && !Number.isFinite(tierId))
  ) {
    return NextResponse.json({ error: "bad params" }, { status: 400 });
  }

  try {
    const meals = await getVariantMeals({
      companyId,
      dietCaloriesId,
      tierId,
    });
    return NextResponse.json({ meals });
  } catch (error) {
    console.error("[variant-meals] query failed", error);
    return NextResponse.json({ error: "query failed" }, { status: 500 });
  }
}
