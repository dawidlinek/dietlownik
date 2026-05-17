"use client";

import { useRouter, useSearchParams } from "next/navigation";
import * as React from "react";

import { DateRangePicker } from "@/components/date-range-picker";
import { DayByDayListSingle } from "@/components/day-by-day-list-single";
import { KcalRangeFilter } from "@/components/kcal-range-filter";
import { PreferenceFilter } from "@/components/preference-filter";
import { SortBar } from "@/components/sort-bar";
import type { MockDay } from "@/lib/mock-match-data";
import type { SortId } from "@/lib/sort-metrics";
import { usePersistedState } from "@/lib/use-persisted-state";

export interface MatchExperience2Props {
  readonly days: readonly MockDay[];
  readonly initialPrefer: readonly string[];
  readonly initialAvoid: readonly string[];
}

const KCAL_STORAGE_KEY = "match.kcal";

interface KcalRange {
  readonly min: number;
  readonly max: number;
}

/**
 * Shares the kcal-URL-persistence dance with /match — both pages should agree
 * on the same stored value, so swapping between /match and /match2 doesn't
 * blow away the user's last range.
 */
const useKcalUrlPersistence = (defaultRange: Readonly<KcalRange>): void => {
  const router = useRouter();
  const searchParams = useSearchParams();
  const hydratedRef = React.useRef(false);

  React.useEffect(() => {
    if (hydratedRef.current) {
      return;
    }
    hydratedRef.current = true;
    const sp = new URLSearchParams(searchParams.toString());
    const hasUrl = sp.has("kcal_min") || sp.has("kcal_max");
    if (hasUrl) {
      return;
    }
    try {
      const stored = globalThis.localStorage?.getItem(KCAL_STORAGE_KEY);
      if (stored === null || stored === undefined) {
        return;
      }
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- KcalRange shape validated by the runtime check below
      const parsed = JSON.parse(stored) as KcalRange;
      if (
        typeof parsed.min === "number" &&
        typeof parsed.max === "number" &&
        (parsed.min !== defaultRange.min || parsed.max !== defaultRange.max)
      ) {
        sp.set("kcal_min", String(parsed.min));
        sp.set("kcal_max", String(parsed.max));
        router.replace(`?${sp.toString()}`, { scroll: false });
      }
    } catch {
      // ignore
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- intentionally run only once on mount
  }, []);

  React.useEffect(() => {
    if (!hydratedRef.current) {
      return;
    }
    const min = searchParams.get("kcal_min");
    const max = searchParams.get("kcal_max");
    if (min === null || max === null) {
      return;
    }
    try {
      globalThis.localStorage?.setItem(
        KCAL_STORAGE_KEY,
        JSON.stringify({ max: Number(max), min: Number(min) })
      );
    } catch {
      // ignore
    }
  }, [searchParams]);
};

const DEFAULT_KCAL: KcalRange = { max: 2000, min: 1500 };

const parseIntOr = (s: string | null, fallback: number): number => {
  if (s === null) {
    return fallback;
  }
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : fallback;
};

export const MatchExperience2 = ({
  days,
  initialAvoid,
  initialPrefer,
}: Readonly<MatchExperience2Props>) => {
  const searchParams = useSearchParams();
  const availableDates = React.useMemo(() => days.map((d) => d.date), [days]);
  const [selectedDates, setSelectedDates] =
    React.useState<readonly string[]>(availableDates);

  const [prefer, setPrefer] = usePersistedState<readonly string[]>(
    "match.prefer",
    initialPrefer
  );
  const [avoid, setAvoid] = usePersistedState<readonly string[]>(
    "match.avoid",
    initialAvoid
  );

  // Sort metric: persist independently so /match2 remembers your last choice.
  const [sortId, setSortId] = usePersistedState<SortId>(
    "match2.sort",
    "score-desc"
  );

  useKcalUrlPersistence(DEFAULT_KCAL);
  const activeMin = parseIntOr(searchParams.get("kcal_min"), DEFAULT_KCAL.min);
  const activeMax = parseIntOr(searchParams.get("kcal_max"), DEFAULT_KCAL.max);

  const filteredDays = React.useMemo(() => {
    const set = new Set(selectedDates);
    return days.filter((d) => set.has(d.date));
  }, [days, selectedDates]);

  return (
    <>
      <div>
        <KcalRangeFilter
          activeDays={1}
          activeMax={activeMax}
          activeMin={activeMin}
          dataMax={3000}
          dataMin={1000}
          dayOptions={[]}
          extraSlot={
            <DateRangePicker
              availableDates={availableDates}
              onChange={setSelectedDates}
              selectedDates={selectedDates}
            />
          }
          presets={[1200, 1500, 1800, 2000, 2500]}
        />
        <div className="px-5 sm:px-8 lg:px-14 py-4 border-b border-[var(--color-bone)]">
          <PreferenceFilter
            avoid={avoid}
            onAvoidChange={setAvoid}
            onPreferChange={setPrefer}
            prefer={prefer}
          />
        </div>
        <SortBar activeId={sortId} onChange={setSortId} />
      </div>

      <main className="flex-1">
        <DayByDayListSingle
          avoid={avoid}
          days={filteredDays}
          prefer={prefer}
          sortId={sortId}
        />
      </main>
    </>
  );
};
