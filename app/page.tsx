import { Suspense } from "react";
import {
  getCities,
  getKcalOptions,
  getDayOptions,
  getDashboardRows,
  getCompaniesInCity,
  getActiveCampaigns,
} from "@/lib/queries";
import { Header } from "@/components/header";
import { FilterStrip } from "@/components/filter-strip";
import { HeroCheapest } from "@/components/hero-cheapest";
import { PromoStrip } from "@/components/promo-strip";
import { PriceTable } from "@/components/price-table";

export const dynamic = "force-dynamic";

const DEFAULT_CITY_ID = 986283; // Wrocław
const DEFAULT_KCAL = 1500;
const DEFAULT_DAYS = 10;

interface PageProps {
  searchParams: Promise<{
    city?: string;
    kcal?: string;
    days?: string;
  }>;
}

export default async function Page({ searchParams }: PageProps) {
  const params = await searchParams;

  // Resolve filters with sensible defaults & coercion.
  const cityId = parseIntOr(params.city, DEFAULT_CITY_ID);
  const kcal = parseIntOr(params.kcal, DEFAULT_KCAL);
  const days = parseIntOr(params.days, DEFAULT_DAYS);

  // Fetch in parallel.
  const [cities, kcalOptions, dayOptions, rows, companies, campaigns] =
    await Promise.all([
      getCities().catch(() => [] as Awaited<ReturnType<typeof getCities>>),
      getKcalOptions(cityId).catch(
        () => [] as Awaited<ReturnType<typeof getKcalOptions>>
      ),
      getDayOptions(cityId).catch(
        () => [] as Awaited<ReturnType<typeof getDayOptions>>
      ),
      getDashboardRows({ cityId, kcal, days }).catch(
        () => [] as Awaited<ReturnType<typeof getDashboardRows>>
      ),
      getCompaniesInCity(cityId).catch(
        () => [] as Awaited<ReturnType<typeof getCompaniesInCity>>
      ),
      getActiveCampaigns().catch(
        () => [] as Awaited<ReturnType<typeof getActiveCampaigns>>
      ),
    ]);

  const activeCity =
    cities.find((c) => c.city_id === cityId) ??
    ({ city_id: cityId, name: "Wrocław" } as const);

  // Latest capture across the visible rows (used as "data freshness" stamp).
  const latestCaptureAt = rows.reduce<string | null>((acc, r) => {
    if (!r.captured_at) return acc;
    if (!acc) return r.captured_at;
    return r.captured_at > acc ? r.captured_at : acc;
  }, null);

  // Make sure the active values are valid; fall back to nearest.
  const safeKcal = kcalOptions.includes(kcal)
    ? kcal
    : kcalOptions[0] ?? kcal;
  const safeDays = dayOptions.includes(days) ? days : dayOptions[0] ?? days;

  return (
    <>
      <Header
        cities={cities}
        kcalOptions={kcalOptions.length ? kcalOptions : [DEFAULT_KCAL]}
        activeCityId={activeCity.city_id}
        activeCityName={activeCity.name}
        activeKcal={safeKcal}
      />

      <Suspense>
        <HeroCheapest
          rows={rows}
          kcal={safeKcal}
          days={safeDays}
          cityName={activeCity.name}
        />
      </Suspense>

      <FilterStrip
        kcalOptions={kcalOptions.length ? kcalOptions : [DEFAULT_KCAL]}
        dayOptions={dayOptions.length ? dayOptions : [DEFAULT_DAYS]}
        activeKcal={safeKcal}
        activeDays={safeDays}
        summary={{
          companies: companies.length,
          pricedRows: rows.length,
          activeCampaigns: campaigns.length,
        }}
      />

      <div className="mt-6">
        <PromoStrip campaigns={campaigns} />
      </div>

      <main className="flex-1">
        <PriceTable
          rows={rows}
          cityId={cityId}
          days={safeDays}
          latestCaptureAt={latestCaptureAt}
        />
      </main>

      <footer className="border-t border-[var(--color-bone)] px-5 sm:px-8 lg:px-14 py-6 text-[12px] text-[var(--color-ink-3)]">
        <span>dietlownik · dane z dietly.pl, scrapowane lokalnie.</span>
      </footer>
    </>
  );
}

function parseIntOr(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}
