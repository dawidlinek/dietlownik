import { DayByDayList } from "@/components/day-by-day-list";
import { Header } from "@/components/header";
import { MatchFilterStrip } from "@/components/match-filter-strip";
import {
  MOCK_ACTIVE_DAYS,
  MOCK_AVOID,
  MOCK_DAYS,
  MOCK_PREFER,
} from "@/lib/mock-match-data";

export const dynamic = "force-dynamic";

// Wrocław — hardcoded for the mock so the page is self-contained.
const DEFAULT_CITY = { city_id: 986_283, name: "Wrocław" };
const MOCK_CITIES = [DEFAULT_CITY] as const;

const Page = () => (
  <>
    <Header
      activeCityId={DEFAULT_CITY.city_id}
      activeCityName={DEFAULT_CITY.name}
      cities={MOCK_CITIES}
    />

    <MatchFilterStrip
      activeDays={MOCK_ACTIVE_DAYS}
      activeMax={2000}
      activeMin={1500}
      dataMax={3000}
      dataMin={1000}
      dayOptions={[5, 7, 10, 14]}
      initialAvoid={MOCK_AVOID}
      initialPrefer={MOCK_PREFER}
      presets={[1200, 1500, 1800, 2000, 2500]}
    />

    <main className="flex-1">
      <DayByDayList avoid={MOCK_AVOID} days={MOCK_DAYS} prefer={MOCK_PREFER} />
    </main>

    <footer className="border-t border-[var(--color-bone)] px-5 sm:px-8 lg:px-14 py-6 text-[12px] text-[var(--color-ink-3)]">
      <span>dietlownik · /match · mock · dane fikcyjne</span>
    </footer>
  </>
);

export default Page;
