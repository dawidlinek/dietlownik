"use client";

import { useRouter, useSearchParams } from "next/navigation";
import * as React from "react";

import { DateRangePicker } from "@/components/date-range-picker";
import { DayByDayListSingle } from "@/components/day-by-day-list-single";
import { KcalRangeFilter } from "@/components/kcal-range-filter";
import { PreferenceFilter } from "@/components/preference-filter";
import { SortBar } from "@/components/sort-bar";
import type { Day } from "@/lib/match-types";
import type { MetricId } from "@/lib/scatter-metrics";
import { sortToYMetricId } from "@/lib/sort-metrics";
import type { SortId } from "@/lib/sort-metrics";
import { usePersistedState } from "@/lib/use-persisted-state";

export interface MatchExperience2Props {
  readonly cityId: number;
  readonly initialDays: readonly Day[];
  readonly availableDates: readonly string[];
  readonly initialPrefer: readonly string[];
  readonly initialAvoid: readonly string[];
  readonly initialSelectedDates: readonly string[];
  readonly initialKcalMin: number;
  readonly initialKcalMax: number;
  readonly dataMin: number;
  readonly dataMax: number;
  readonly presets: readonly number[];
}

const KCAL_STORAGE_KEY = "match.kcal";
const REFETCH_DEBOUNCE_MS = 280;

interface KcalRange {
  readonly min: number;
  readonly max: number;
}

const parseIntOr = (s: string | null, fallback: number): number => {
  if (s === null) {
    return fallback;
  }
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : fallback;
};

const parseList = (raw: string | null): readonly string[] => {
  if (raw === null || raw === "") {
    return [];
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
};

const arraysEqual = (a: readonly string[], b: readonly string[]): boolean => {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
};

interface MatchWeekResponse {
  readonly days?: readonly Day[];
  readonly error?: string;
}

/**
 * KcalRangeFilter writes kcal_min/kcal_max to the URL. We layer localStorage
 * persistence on top so the user's last kcal range survives across visits.
 */
const useKcalLocalStoragePersistence = (): void => {
  const router = useRouter();
  const searchParams = useSearchParams();
  const hydratedRef = React.useRef(false);

  React.useEffect(() => {
    if (hydratedRef.current) {
      return;
    }
    hydratedRef.current = true;
    const sp = new URLSearchParams(searchParams.toString());
    if (sp.has("kcal_min") || sp.has("kcal_max")) {
      return;
    }
    try {
      const stored = globalThis.localStorage?.getItem(KCAL_STORAGE_KEY);
      if (stored === null || stored === undefined) {
        return;
      }
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- shape validated below
      const parsed = JSON.parse(stored) as KcalRange;
      if (typeof parsed.min === "number" && typeof parsed.max === "number") {
        sp.set("kcal_min", String(parsed.min));
        sp.set("kcal_max", String(parsed.max));
        router.replace(`?${sp.toString()}`, { scroll: false });
      }
    } catch {
      // ignore
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- run once
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

export const MatchExperience2 = ({
  availableDates,
  cityId,
  dataMax,
  dataMin,
  initialAvoid,
  initialDays,
  initialKcalMax,
  initialKcalMin,
  initialPrefer,
  initialSelectedDates,
  presets,
}: Readonly<MatchExperience2Props>) => {
  const router = useRouter();
  const searchParams = useSearchParams();

  // URL params are the source of truth for prefer/avoid/dates. Initial values
  // come from the server (which parsed the same params).
  const urlPrefer = React.useMemo(
    () => parseList(searchParams.get("prefer")),
    [searchParams]
  );
  const urlAvoid = React.useMemo(
    () => parseList(searchParams.get("avoid")),
    [searchParams]
  );
  const urlDates = React.useMemo(() => {
    const got = parseList(searchParams.get("dates"));
    return got.length > 0 ? got : initialSelectedDates;
  }, [searchParams, initialSelectedDates]);

  // Effective filter state: read from URL when present, otherwise from initial.
  const prefer = searchParams.has("prefer") ? urlPrefer : initialPrefer;
  const avoid = searchParams.has("avoid") ? urlAvoid : initialAvoid;
  const selectedDates = urlDates;
  const activeMin = parseIntOr(searchParams.get("kcal_min"), initialKcalMin);
  const activeMax = parseIntOr(searchParams.get("kcal_max"), initialKcalMax);

  // Helper that produces a fresh URLSearchParams with one or more updates.
  const writeUrl = React.useCallback(
    (updates: Readonly<Record<string, string | null>>) => {
      const sp = new URLSearchParams(searchParams.toString());
      for (const [k, v] of Object.entries(updates)) {
        if (v === null || v === "") {
          sp.delete(k);
        } else {
          sp.set(k, v);
        }
      }
      router.replace(`?${sp.toString()}`, { scroll: false });
    },
    [router, searchParams]
  );

  const setPrefer = React.useCallback(
    (next: readonly string[]) => {
      writeUrl({ prefer: next.length === 0 ? null : next.join(",") });
    },
    [writeUrl]
  );
  const setAvoid = React.useCallback(
    (next: readonly string[]) => {
      writeUrl({ avoid: next.length === 0 ? null : next.join(",") });
    },
    [writeUrl]
  );
  const setSelectedDates = React.useCallback(
    (next: readonly string[]) => {
      // If selection equals the full available pool, drop the param entirely.
      const sameAsAll =
        next.length === availableDates.length &&
        next.every((d) => availableDates.includes(d));
      writeUrl({ dates: sameAsAll ? null : next.join(",") });
    },
    [availableDates, writeUrl]
  );

  // Sort + scatter axes — local UI state, not server-affecting, so localStorage
  // persistence (not URL) is fine.
  const [sortId, setSortId] = usePersistedState<SortId>(
    "match2.sort",
    "score-desc"
  );
  const [xId, setXId] = usePersistedState<MetricId>("match.scatter.x", "price");
  const [yId, setYId] = usePersistedState<MetricId>("match.scatter.y", "score");

  const handleSortChange = React.useCallback(
    (id: SortId) => {
      setSortId(id);
      setXId("price");
      setYId(sortToYMetricId(id));
    },
    [setSortId, setXId, setYId]
  );

  useKcalLocalStoragePersistence();

  // ── Live data: refetch when filters change ───────────────────────────────
  const [days, setDays] = React.useState<readonly Day[]>(initialDays);
  const [pending, setPending] = React.useState(false);
  const [fetchError, setFetchError] = React.useState<string | null>(null);

  // Track the filters that match the currently-loaded `days`. On the very
  // first render this is the initial server-rendered snapshot; we skip the
  // immediate refetch when filters match.
  const loadedFiltersRef = React.useRef({
    avoid: initialAvoid,
    dates: initialSelectedDates,
    kcalMax: initialKcalMax,
    kcalMin: initialKcalMin,
    prefer: initialPrefer,
  });

  // oxlint-disable-next-line react-hooks/exhaustive-deps -- deps tracked manually below
  React.useEffect(() => {
    const lf = loadedFiltersRef.current;
    const samePrefer = arraysEqual(prefer, lf.prefer);
    const sameAvoid = arraysEqual(avoid, lf.avoid);
    const sameDates = arraysEqual(selectedDates, lf.dates);
    const sameKcal = activeMin === lf.kcalMin && activeMax === lf.kcalMax;
    if (
      (samePrefer && sameAvoid && sameDates && sameKcal) ||
      selectedDates.length === 0
    ) {
      return () => {
        // no-op cleanup — every code path must return a cleanup for consistent-return
      };
    }
    const ctrl = new AbortController();
    const runFetch = async () => {
      setPending(true);
      setFetchError(null);
      const sp = new URLSearchParams();
      sp.set("city_id", String(cityId));
      sp.set("dates", selectedDates.join(","));
      if (prefer.length > 0) {
        sp.set("prefer", prefer.join(","));
      }
      if (avoid.length > 0) {
        sp.set("avoid", avoid.join(","));
      }
      sp.set("kcal_min", String(activeMin));
      sp.set("kcal_max", String(activeMax));
      try {
        const res = await fetch(`/api/match-week?${sp.toString()}`, {
          signal: ctrl.signal,
        });
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- shape narrowed at use sites
        const json = (await res.json()) as MatchWeekResponse;
        if (!res.ok) {
          throw new Error(json.error ?? `HTTP ${res.status}`);
        }
        loadedFiltersRef.current = {
          avoid,
          dates: selectedDates,
          kcalMax: activeMax,
          kcalMin: activeMin,
          prefer,
        };
        setDays(json.days ?? []);
      } catch (error: unknown) {
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }
        const msg = error instanceof Error ? error.message : "fetch failed";
        setFetchError(msg);
      } finally {
        setPending(false);
      }
    };
    const t = window.setTimeout(() => {
      void runFetch();
    }, REFETCH_DEBOUNCE_MS);
    return () => {
      ctrl.abort();
      window.clearTimeout(t);
    };
  }, [activeMax, activeMin, avoid, cityId, prefer, selectedDates]);

  return (
    <>
      <div>
        <KcalRangeFilter
          activeDays={1}
          activeMax={activeMax}
          activeMin={activeMin}
          dataMax={dataMax}
          dataMin={dataMin}
          dayOptions={[]}
          extraSlot={
            <DateRangePicker
              availableDates={availableDates}
              onChange={setSelectedDates}
              selectedDates={selectedDates}
            />
          }
          presets={presets}
        />
        <div className="px-5 sm:px-8 lg:px-14 py-4 border-b border-[var(--color-bone)]">
          <PreferenceFilter
            avoid={avoid}
            onAvoidChange={setAvoid}
            onPreferChange={setPrefer}
            prefer={prefer}
          />
        </div>
        <SortBar activeId={sortId} onChange={handleSortChange} />
        {fetchError !== null && (
          <div className="px-5 sm:px-8 lg:px-14 py-2 text-[12px] text-[var(--color-paprika)]">
            nie udało się załadować ofert: {fetchError}
          </div>
        )}
      </div>

      <main
        className={`flex-1 ${pending ? "opacity-70 transition-opacity" : ""}`}
      >
        <DayByDayListSingle
          days={days}
          onChangeX={setXId}
          onChangeY={setYId}
          sortId={sortId}
          xId={xId}
          yId={yId}
        />
      </main>
    </>
  );
};
