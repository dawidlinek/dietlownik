import { CateringList } from "@/components/catering-list";
import { Header } from "@/components/header";
import { KcalRangeFilter } from "@/components/kcal-range-filter";
import {
  getActiveCampaigns,
  getCateringPage,
  getCities,
  getDayOptions,
  getKcalBounds,
} from "@/lib/queries";

export const dynamic = "force-dynamic";

// Wrocław
const DEFAULT_CITY_ID = 986_283;
const DEFAULT_KCAL_MIN = 1500;
const DEFAULT_KCAL_MAX = 2000;
const DEFAULT_DAYS = 10;
const DEFAULT_PAGE_SIZE = 25;

interface PageProps {
  searchParams: Promise<{
    city?: string;
    /** legacy: single value → kcal_min=kcal_max=kcal */
    kcal?: string;
    kcal_min?: string;
    kcal_max?: string;
    days?: string;
    page?: string;
  }>;
}

const parseIntOr = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
};

const Page = async ({ searchParams }: PageProps) => {
  const params = await searchParams;

  const cityId = parseIntOr(params.city, DEFAULT_CITY_ID);

  // Legacy ?kcal=X support: collapse to a single-value range.
  const legacyKcal =
    params.kcal === undefined || params.kcal === ""
      ? Number.NaN
      : parseIntOr(params.kcal, Number.NaN);
  let kcalMin = parseIntOr(
    params.kcal_min,
    Number.isFinite(legacyKcal) ? legacyKcal : DEFAULT_KCAL_MIN
  );
  let kcalMax = parseIntOr(
    params.kcal_max,
    Number.isFinite(legacyKcal) ? legacyKcal : DEFAULT_KCAL_MAX
  );
  if (kcalMin > kcalMax) {
    [kcalMin, kcalMax] = [kcalMax, kcalMin];
  }

  const days = parseIntOr(params.days, DEFAULT_DAYS);
  const page = Math.max(1, parseIntOr(params.page, 1));

  const [cities, bounds, dayOptions, pageData, campaigns] = await Promise.all([
    getCities().catch(() => [] as Awaited<ReturnType<typeof getCities>>),
    getKcalBounds(cityId).catch(() => ({
      max: 3000,
      min: 1000,
      presets: [1200, 1500, 1800, 2000, 2500],
    })),
    getDayOptions(cityId).catch(
      () => [] as Awaited<ReturnType<typeof getDayOptions>>
    ),
    getCateringPage({
      cityId,
      days,
      kcalMax,
      kcalMin,
      page,
      pageSize: DEFAULT_PAGE_SIZE,
    }).catch(() => ({
      page,
      pageSize: DEFAULT_PAGE_SIZE,
      rangeMax: null,
      rangeMin: null,
      tiles: [],
      total: 0,
    })),
    getActiveCampaigns().catch(
      () => [] as Awaited<ReturnType<typeof getActiveCampaigns>>
    ),
  ]);

  const activeCity = cities.find((c) => c.city_id === cityId) ?? {
    city_id: cityId,
    name: "Wrocław",
  };

  // Latest capture across visible tiles for the freshness footer.
  let latestCaptureAt: string | null = null;
  for (const t of pageData.tiles) {
    const cap = t.cheapest.captured_at;
    if (cap === null || cap === undefined || cap === "") {
      continue;
    }
    if (latestCaptureAt === null || cap > latestCaptureAt) {
      latestCaptureAt = cap;
    }
  }

  // Don't silently clamp the requested range — if a user asked for 9000-10000
  // we want to render the empty state, not pretend they asked for 4000. The
  // KcalRangeFilter input clamps live typing visually; bounds are passed
  // through so it knows the slider extents.
  const safeMin = kcalMin;
  const safeMax = kcalMax;
  const safeDays = dayOptions.includes(days) ? days : (dayOptions[0] ?? days);

  return (
    <>
      <Header
        activeCityId={activeCity.city_id}
        activeCityName={activeCity.name}
        cities={cities}
      />

      <KcalRangeFilter
        activeDays={safeDays}
        activeMax={safeMax}
        activeMin={safeMin}
        dataMax={bounds.max}
        dataMin={bounds.min}
        dayOptions={dayOptions.length ? dayOptions : [DEFAULT_DAYS]}
        presets={bounds.presets}
      />

      <main className="flex-1">
        <CateringList
          campaigns={campaigns}
          cityId={cityId}
          cityName={activeCity.name}
          days={safeDays}
          kcalMax={safeMax}
          kcalMin={safeMin}
          latestCaptureAt={latestCaptureAt}
          page={pageData.page}
          pageSize={pageData.pageSize}
          rangeMax={pageData.rangeMax}
          rangeMin={pageData.rangeMin}
          tiles={pageData.tiles}
          total={pageData.total}
        />
      </main>

      <footer className="border-t border-[var(--color-bone)] px-5 sm:px-8 lg:px-14 py-6 text-[12px] text-[var(--color-ink-3)]">
        <span>dietlownik · dane z dietly.pl, scrapowane lokalnie.</span>
      </footer>
    </>
  );
};

export default Page;
