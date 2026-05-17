import { Header } from "@/components/header";
import { MatchExperience2 } from "@/components/match-experience-2";
import { MOCK_AVOID, MOCK_DAYS, MOCK_PREFER } from "@/lib/mock-match-data";

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

    <MatchExperience2
      days={MOCK_DAYS}
      initialAvoid={MOCK_AVOID}
      initialPrefer={MOCK_PREFER}
    />

    <footer className="border-t border-[var(--color-bone)] px-5 sm:px-8 lg:px-14 py-6 text-[12px] text-[var(--color-ink-3)]">
      <span>dietlownik · /match2 · mock · jedna oferta na dzień</span>
    </footer>
  </>
);

export default Page;
