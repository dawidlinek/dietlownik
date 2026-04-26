import { NextResponse } from "next/server";
import { getPriceHistory } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const companyId = searchParams.get("company_id");
  const dietCaloriesId = Number(searchParams.get("diet_calories_id"));
  const cityId = Number(searchParams.get("city_id"));
  const days = Number(searchParams.get("days"));

  if (
    !companyId ||
    !Number.isFinite(dietCaloriesId) ||
    !Number.isFinite(cityId) ||
    !Number.isFinite(days)
  ) {
    return NextResponse.json({ error: "bad params" }, { status: 400 });
  }

  try {
    const history = await getPriceHistory({
      companyId,
      dietCaloriesId,
      cityId,
      days,
    });
    return NextResponse.json({ history });
  } catch (err) {
    console.error("[price-history] query failed", err);
    return NextResponse.json(
      { error: "query failed" },
      { status: 500 }
    );
  }
}
