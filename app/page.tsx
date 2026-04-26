import {
  getCities,
  getKcalBounds,
  getDayOptions,
  getCateringPage,
  getActiveCampaigns,
} from "@/lib/queries";
import { Header } from "@/components/header";
import { KcalRangeFilter } from "@/components/kcal-range-filter";
import { CateringList } from "@/components/catering-list";

export const dynamic = "force-dynamic";

const DEFAULT_CITY_ID = 986283; // Wrocław
const DEFAULT_KCAL_MIN = 1500;
const DEFAULT_KCAL_MAX = 2000;
const DEFAULT_DAYS = 10;
const DEFAULT_PAGE_SIZE = 25;

interface PageProps {
  searchParams: Promise<{
    city?: string;
    kcal?: string;        // legacy: single value → kcal_min=kcal_max=kcal
    kcal_min?: string;
    kcal_max?: string;
    days?: string;
    page?: string;
  }>;
}

export default async function Page({ searchParams }: PageProps) {
  const params = await searchParams;

  const cityId = parseIntOr(params.city, DEFAULT_CITY_ID);

  // Legacy ?kcal=X support: collapse to a single-value range.
  const legacyKcal = params.kcal ? parseIntOr(params.kcal, NaN) : NaN;
  let kcalMin = parseIntOr(params.kcal_min, Number.isFinite(legacyKcal) ? legacyKcal : DEFAULT_KCAL_MIN);
  let kcalMax = parseIntOr(params.kcal_max, Number.isFinite(legacyKcal) ? legacyKcal : DEFAULT_KCAL_MAX);
  if (kcalMin > kcalMax) [kcalMin, kcalMax] = [kcalMax, kcalMin];

  const days = parseIntOr(params.days, DEFAULT_DAYS);
  const page = Math.max(1, parseIntOr(params.page, 1));

  const [cities, bounds, dayOptions, pageData, campaigns] = await Promise.all([
    getCities().catch(() => [] as Awaited<ReturnType<typeof getCities>>),
    getKcalBounds(cityId).catch(() => ({
      min: 1000,
      max: 3000,
      presets: [1200, 1500, 1800, 2000, 2500],
    })),
    getDayOptions(cityId).catch(
      () => [] as Awaited<ReturnType<typeof getDayOptions>>
    ),
    getCateringPage({
      cityId,
      kcalMin,
      kcalMax,
      days,
      page,
      pageSize: DEFAULT_PAGE_SIZE,
    }).catch(() => ({
      tiles: [],
      total: 0,
      page,
      pageSize: DEFAULT_PAGE_SIZE,
      rangeMin: null,
      rangeMax: null,
    })),
    getActiveCampaigns().catch(
      () => [] as Awaited<ReturnType<typeof getActiveCampaigns>>
    ),
  ]);

  const activeCity =
    cities.find((c) => c.city_id === cityId) ??
    ({ city_id: cityId, name: "Wrocław" } as const);

  // Latest capture across visible tiles for the freshness footer.
  const latestCaptureAt = pageData.tiles.reduce<string | null>((acc, t) => {
    const cap = t.cheapest.captured_at;
    if (!cap) return acc;
    if (!acc) return cap;
    return cap > acc ? cap : acc;
  }, null);

  // Don't silently clamp the requested range — if a user asked for 9000-10000
  // we want to render the empty state, not pretend they asked for 4000. The
  // KcalRangeFilter input clamps live typing visually; bounds are passed
  // through so it knows the slider extents.
  const safeMin = kcalMin;
  const safeMax = kcalMax;
  const safeDays = dayOptions.includes(days) ? days : dayOptions[0] ?? days;

  return (
    <>
      <Header
        cities={cities}
        activeCityId={activeCity.city_id}
        activeCityName={activeCity.name}
      />

      <KcalRangeFilter
        dataMin={bounds.min}
        dataMax={bounds.max}
        presets={bounds.presets}
        activeMin={safeMin}
        activeMax={safeMax}
        dayOptions={dayOptions.length ? dayOptions : [DEFAULT_DAYS]}
        activeDays={safeDays}
      />

      <main className="flex-1">
        <CateringList
          tiles={pageData.tiles}
          total={pageData.total}
          page={pageData.page}
          pageSize={pageData.pageSize}
          campaigns={campaigns}
          cityId={cityId}
          days={safeDays}
          kcalMin={safeMin}
          kcalMax={safeMax}
          cityName={activeCity.name}
          rangeMin={pageData.rangeMin}
          rangeMax={pageData.rangeMax}
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
