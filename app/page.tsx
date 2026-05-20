import { Header } from "@/components/header";
import { MatchExperience2 } from "@/components/match-experience-2";
import { toViewDay } from "@/lib/match-types";
import {
  getAvailableDates,
  getCities,
  getKcalBounds,
  getWeekView,
} from "@/lib/queries";

export const dynamic = "force-dynamic";

// Wrocław
const DEFAULT_CITY_ID = 986_283;
const DEFAULT_KCAL_MIN = 1500;
const DEFAULT_KCAL_MAX = 2000;
// Picker cap. Caterings publish ~1–2 weeks ahead in practice, so 90 is
// effectively "everything available" — the SQL still bounds by what's in
// current_daily_menu, so the picker reflects the real DB tail.
const DEFAULT_WINDOW_DAYS = 90;
/** Caterings need lead time — same-day and next-day orders aren't possible,
 *  so the earliest sensible default is two calendar days out. */
const ORDER_LEAD_DAYS = 2;

interface PageProps {
  readonly searchParams: Promise<
    Readonly<{
      city?: string;
      kcal_min?: string;
      kcal_max?: string;
      prefer?: string;
      avoid?: string;
      dates?: string;
    }>
  >;
}

const parseIntOr = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
};

const parseList = (raw: string | undefined): readonly string[] => {
  if (raw === undefined || raw === "") {
    return [];
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
};

/** YYYY-MM-DD for a Europe/Warsaw date `offsetDays` from today (negative = past). */
const warsawDatePlus = (offsetDays: number): string => {
  const ms = Date.now() + offsetDays * 86_400_000;
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Europe/Warsaw",
    year: "numeric",
  }).format(new Date(ms));
};

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Next.js page props expose searchParams as a Promise
const Page = async ({ searchParams }: Readonly<PageProps>) => {
  const params = await searchParams;

  const cityId = parseIntOr(params.city, DEFAULT_CITY_ID);
  let kcalMin = parseIntOr(params.kcal_min, DEFAULT_KCAL_MIN);
  let kcalMax = parseIntOr(params.kcal_max, DEFAULT_KCAL_MAX);
  if (kcalMin > kcalMax) {
    [kcalMin, kcalMax] = [kcalMax, kcalMin];
  }
  const prefer = parseList(params.prefer);
  const avoid = parseList(params.avoid);
  const urlDates = parseList(params.dates);

  const [cities, bounds, availableDatesAll] = await Promise.all([
    getCities().catch(() => [] as Awaited<ReturnType<typeof getCities>>),
    getKcalBounds(cityId).catch(() => ({
      max: 3000,
      min: 1000,
      presets: [1200, 1500, 1800, 2000, 2500],
    })),
    getAvailableDates(
      cityId,
      warsawDatePlus(ORDER_LEAD_DAYS),
      DEFAULT_WINDOW_DAYS
    ).catch(() => [] as string[]),
  ]);

  const activeCity = cities.find((c) => c.city_id === cityId) ?? {
    city_id: cityId,
    name: "Wrocław",
  };

  // Selected dates = URL param if given, else all available dates.
  const selectedDates =
    urlDates.length > 0
      ? urlDates.filter((d) => availableDatesAll.includes(d))
      : availableDatesAll;
  const effectiveDates =
    selectedDates.length > 0 ? selectedDates : availableDatesAll;

  const weekView = await getWeekView({
    avoid,
    cityId,
    dates: effectiveDates,
    kcalMax,
    kcalMin,
    prefer,
  }).catch(() => [] as Awaited<ReturnType<typeof getWeekView>>);

  const initialDays = weekView.map(toViewDay);

  return (
    <>
      <Header
        activeCityId={activeCity.city_id}
        activeCityName={activeCity.name}
        cities={cities}
      />

      <MatchExperience2
        availableDates={availableDatesAll}
        cityId={cityId}
        dataMax={bounds.max}
        dataMin={bounds.min}
        initialAvoid={avoid}
        initialDays={initialDays}
        initialKcalMax={kcalMax}
        initialKcalMin={kcalMin}
        initialPrefer={prefer}
        initialSelectedDates={effectiveDates}
        presets={bounds.presets}
      />

      <footer className="border-t border-[var(--color-bone)] px-5 sm:px-8 lg:px-14 py-6 text-[12px] text-[var(--color-ink-3)]">
        <span>dietlownik · dane z dietly.pl, scrapowane lokalnie.</span>
      </footer>
    </>
  );
};

export default Page;
