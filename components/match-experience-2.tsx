"use client";

import { useRouter, useSearchParams } from "next/navigation";
import * as React from "react";

import { DateRangePicker } from "@/components/date-range-picker";
import { DayByDayListSingle } from "@/components/day-by-day-list-single";
import { ExcludeFilter } from "@/components/exclude-filter";
import type { CateringChoice } from "@/components/exclude-filter";
import { KcalRangeFilter } from "@/components/kcal-range-filter";
import { PreferenceFilter } from "@/components/preference-filter";
import { SortBar } from "@/components/sort-bar";
import type { Day, Offer } from "@/lib/match-types";
import type { MetricId } from "@/lib/scatter-metrics";
import { sortToYMetricId } from "@/lib/sort-metrics";
import type { SortId } from "@/lib/sort-metrics";
import { usePersistedState } from "@/lib/use-persisted-state";

export interface MatchExperience2Props {
  readonly cityId: number;
  readonly initialDays: readonly Day[];
  readonly availableDates: readonly string[];
  readonly availableCaterings: readonly CateringChoice[];
  readonly initialPrefer: readonly string[];
  readonly initialAvoid: readonly string[];
  readonly initialExclude: readonly string[];
  readonly initialSelectedDates: readonly string[];
  readonly initialKcalMin: number;
  readonly initialKcalMax: number;
  readonly dataMin: number;
  readonly dataMax: number;
  readonly presets: readonly number[];
}

const KCAL_STORAGE_KEY = "match.kcal";
const REFETCH_DEBOUNCE_MS = 280;

/**
 * Maps a per-zł ratio sort to the raw-metric sort it derives from. When a
 * user has a per-zł sort active, Phase B fans out into three branches —
 * cheapest + highest raw + best ratio — and this lookup gives us the
 * "highest raw" branch. `kcal-per-zl` has no raw "kcal-desc" cousin in
 * SortId, so it stays out of the table and falls through to the 2-branch
 * sort+price load.
 */
const PER_ZL_TO_RAW: Partial<Record<SortId, SortId>> = {
  "fiber-per-zl": "fiber-desc",
  "protein-per-zl": "protein-desc",
  "review-per-zl": "review-desc",
  "score-per-zl": "score-desc",
};

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
  availableCaterings,
  availableDates,
  cityId,
  dataMax,
  dataMin,
  initialAvoid,
  initialDays,
  initialExclude,
  initialKcalMax,
  initialKcalMin,
  initialPrefer,
  initialSelectedDates,
  presets,
}: Readonly<MatchExperience2Props>) => {
  const router = useRouter();
  const searchParams = useSearchParams();

  // URL params are the source of truth for prefer/avoid/dates/exclude. Initial
  // values come from the server (which parsed the same params).
  const urlPrefer = React.useMemo(
    () => parseList(searchParams.get("prefer")),
    [searchParams]
  );
  const urlAvoid = React.useMemo(
    () => parseList(searchParams.get("avoid")),
    [searchParams]
  );
  const urlExclude = React.useMemo(
    () => parseList(searchParams.get("exclude")),
    [searchParams]
  );
  const urlDates = React.useMemo(() => {
    const got = parseList(searchParams.get("dates"));
    return got.length > 0 ? got : initialSelectedDates;
  }, [searchParams, initialSelectedDates]);

  // Effective filter state: read from URL when present, otherwise from initial.
  const prefer = searchParams.has("prefer") ? urlPrefer : initialPrefer;
  const avoid = searchParams.has("avoid") ? urlAvoid : initialAvoid;
  const exclude = searchParams.has("exclude") ? urlExclude : initialExclude;
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
  const setExclude = React.useCallback(
    (next: readonly string[]) => {
      writeUrl({ exclude: next.length === 0 ? null : next.join(",") });
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

  // Score chips (score, score/zł) only mean something when prefer/avoid is set.
  // When neither is, the chip would rank by uniformly-zero scores — surface
  // gets hidden in the SortBar and we redirect the active sort to "price-asc".
  const hasPreferences = prefer.length > 0 || avoid.length > 0;
  React.useEffect(() => {
    if (
      !hasPreferences &&
      (sortId === "score-desc" || sortId === "score-per-zl")
    ) {
      setSortId("price-asc");
      setYId("score");
    }
  }, [hasPreferences, setSortId, setYId, sortId]);

  const handleSortChange = React.useCallback(
    (id: SortId) => {
      setSortId(id);
      setXId("price");
      setYId(sortToYMetricId(id));
    },
    [setSortId, setXId, setYId]
  );

  useKcalLocalStoragePersistence();

  // ── Live data: two-phase lazy loader ─────────────────────────────────────
  //
  // Phase A — `limit=1` per day, the winner only. Fires on initial mount
  //   (when SSR ships no days) and on every filter change. Hydrates the
  //   table with skeleton placeholders → top-1 rows.
  // Phase B — `limit=0` (full pool) for a single date. Fires only when the
  //   user expands that day's row. Cached in `poolByDate` so a subsequent
  //   collapse + re-expand is instant. Cleared and aborted on the next
  //   filter change.
  //
  // SSR ships `initialDays === []` so the page navigates instantly; we
  // render skeleton rows immediately and let the first effect fire Phase A.
  const hasInitialData = initialDays.length > 0;
  const [days, setDays] = React.useState<readonly Day[]>(initialDays);
  const [skeletonDates, setSkeletonDates] = React.useState<
    readonly string[] | null
  >(() => (hasInitialData ? null : initialSelectedDates));
  const [poolByDate, setPoolByDate] = React.useState<
    Readonly<Record<string, readonly Offer[]>>
  >(() => {
    // Only seed when SSR shipped the full pool. With the slow query skipped
    // on SSR (the default), this is empty and the first expand fetches.
    if (!hasInitialData) {
      return {};
    }
    const out: Record<string, readonly Offer[]> = {};
    for (const d of initialDays) {
      out[d.date] = d.all_offers;
    }
    return out;
  });
  const [loadingPoolDates, setLoadingPoolDates] = React.useState<
    ReadonlySet<string>
  >(() => new Set());
  const [fetchError, setFetchError] = React.useState<string | null>(null);

  // Per-day pool fetch controllers. Filter changes abort everything in here
  // so stale full-pool results never overwrite Phase A's top-1 data.
  const poolControllersRef = React.useRef<Map<string, AbortController>>(
    new Map()
  );

  // Per-catering loading state: keyed by `${date}::${companyId}`. Filter
  // changes abort these too — see the Phase A effect's cleanup block.
  const [loadingCaterings, setLoadingCaterings] = React.useState<
    ReadonlySet<string>
  >(() => new Set());
  const cateringControllersRef = React.useRef<Map<string, AbortController>>(
    new Map()
  );

  // Filter set the current `days` reflects. `null` means we haven't loaded
  // anything yet — the next effect run treats every filter set as a miss
  // and fires Phase A. After Phase A resolves we set this to the filters
  // that produced the data.
  interface FilterSnapshot {
    readonly avoid: readonly string[];
    readonly dates: readonly string[];
    readonly exclude: readonly string[];
    readonly kcalMax: number;
    readonly kcalMin: number;
    readonly prefer: readonly string[];
    readonly sort: SortId;
  }
  const loadedFiltersRef = React.useRef<FilterSnapshot | null>(
    hasInitialData
      ? {
          avoid: initialAvoid,
          dates: initialSelectedDates,
          exclude: initialExclude,
          kcalMax: initialKcalMax,
          kcalMin: initialKcalMin,
          prefer: initialPrefer,
          sort: "score-desc",
        }
      : null
  );

  const buildMatchUrl = React.useCallback(
    (
      datesArg: readonly string[],
      limit: number | null,
      includeCompanyIds?: readonly string[],
      sortOverride?: SortId
    ): string => {
      const sp = new URLSearchParams();
      sp.set("city_id", String(cityId));
      sp.set("dates", datesArg.join(","));
      if (prefer.length > 0) {
        sp.set("prefer", prefer.join(","));
      }
      if (avoid.length > 0) {
        sp.set("avoid", avoid.join(","));
      }
      if (exclude.length > 0) {
        sp.set("exclude", exclude.join(","));
      }
      if (includeCompanyIds && includeCompanyIds.length > 0) {
        sp.set("include", includeCompanyIds.join(","));
      }
      sp.set("kcal_min", String(activeMin));
      sp.set("kcal_max", String(activeMax));
      sp.set("sort", sortOverride ?? sortId);
      if (limit !== null) {
        sp.set("limit", String(limit));
      }
      return `/api/match-week?${sp.toString()}`;
    },
    [activeMax, activeMin, avoid, cityId, exclude, prefer, sortId]
  );

  // Phase A refetch on initial mount (no SSR data) and on filter change.
  // Also clears poolByDate / aborts in flight pool fetches so the user
  // doesn't see scatter points from a previous filter state momentarily
  // overlaid on the new top-1 rows.
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- deps tracked manually below
  React.useEffect(() => {
    if (selectedDates.length === 0) {
      return () => {
        // nothing to fetch — render path shows "brak danych" naturally
      };
    }
    const lf = loadedFiltersRef.current;
    if (lf !== null) {
      const samePrefer = arraysEqual(prefer, lf.prefer);
      const sameAvoid = arraysEqual(avoid, lf.avoid);
      const sameExclude = arraysEqual(exclude, lf.exclude);
      const sameDates = arraysEqual(selectedDates, lf.dates);
      const sameKcal = activeMin === lf.kcalMin && activeMax === lf.kcalMax;
      const sameSort = sortId === lf.sort;
      if (
        samePrefer &&
        sameAvoid &&
        sameExclude &&
        sameDates &&
        sameKcal &&
        sameSort
      ) {
        return () => {
          // current `days` already match these filters
        };
      }
    }
    for (const [, c] of poolControllersRef.current) {
      c.abort();
    }
    poolControllersRef.current.clear();
    for (const [, c] of cateringControllersRef.current) {
      c.abort();
    }
    cateringControllersRef.current.clear();
    setLoadingPoolDates(new Set());
    setLoadingCaterings(new Set());
    setPoolByDate({});
    // Show the skeleton synchronously — the user gets instant feedback that
    // their filter is being honored, even though the actual fetch is debounced.
    setSkeletonDates(selectedDates);
    const ctrl = new AbortController();
    const runFetch = async () => {
      setFetchError(null);
      try {
        const res = await fetch(buildMatchUrl(selectedDates, 1), {
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
          exclude,
          kcalMax: activeMax,
          kcalMin: activeMin,
          prefer,
          sort: sortId,
        };
        setDays(json.days ?? []);
        setSkeletonDates(null);
      } catch (error: unknown) {
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }
        const msg = error instanceof Error ? error.message : "fetch failed";
        setFetchError(msg);
        setSkeletonDates(null);
      }
    };
    const t = window.setTimeout(() => {
      void runFetch();
    }, REFETCH_DEBOUNCE_MS);
    return () => {
      ctrl.abort();
      window.clearTimeout(t);
    };
  }, [
    activeMax,
    activeMin,
    avoid,
    buildMatchUrl,
    cityId,
    exclude,
    prefer,
    selectedDates,
    sortId,
  ]);

  // Fired by the list when the user expands a day. Idempotent: cached or
  // in-flight dates are no-ops.
  //
  // Pool composition depends on the current sort:
  //   * per-zł ratio (e.g. protein-per-zl) → 3 parallel limit=5 fetches:
  //       1) best ratio        (the sort itself)
  //       2) highest raw value (e.g. protein-desc — `PER_ZL_TO_RAW`)
  //       3) cheapest          (price-asc)
  //     Surfaces all three "value" perspectives at once.
  //   * everything else → 2 parallel limit=8 fetches: the user's sort + price.
  //     (price-asc skips the second branch — already covered.)
  //
  // Branches are issued primary-intent-first, then merged with a first-
  // occurrence-wins dedupe — so when the same offer surfaces from two
  // branches, the primary's attribution (and ordering) survives.
  const requestPool = React.useCallback(
    (date: string) => {
      if (date in poolByDate || loadingPoolDates.has(date)) {
        return;
      }
      const ctrl = new AbortController();
      poolControllersRef.current.set(date, ctrl);
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- React setter receives the previous Set value
      setLoadingPoolDates((prev) => new Set([...prev, date]));
      const fetchPoolWith = async (
        sortOverride: SortId | undefined,
        limit: number
      ): Promise<readonly Offer[]> => {
        const res = await fetch(
          buildMatchUrl([date], limit, undefined, sortOverride),
          { signal: ctrl.signal }
        );
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- shape narrowed at use sites
        const json = (await res.json()) as MatchWeekResponse;
        if (!res.ok) {
          throw new Error(json.error ?? `HTTP ${res.status}`);
        }
        const dayResult = (json.days ?? []).find((d) => d.date === date);
        return dayResult?.all_offers ?? [];
      };
      const rawForRatio = PER_ZL_TO_RAW[sortId];
      void (async () => {
        try {
          // Branches are ordered so the user's primary intent (sort for the
          // 2-branch path, ratio for the 3-branch path) is FIRST — the
          // first-occurrence-wins merge below preserves those offers
          // against ties from the secondary branches.
          let branches: readonly (readonly Offer[])[];
          if (rawForRatio === undefined) {
            // 2-branch: user's sort + price. price-asc skips its own branch.
            const priceBranch =
              sortId === "price-asc"
                ? Promise.resolve([] as readonly Offer[])
                : fetchPoolWith("price-asc", 8);
            branches = await Promise.all([
              fetchPoolWith(undefined, 8),
              priceBranch,
            ]);
          } else {
            // 3-branch: best ratio + highest raw + cheapest.
            branches = await Promise.all([
              fetchPoolWith(sortId, 5),
              fetchPoolWith(rawForRatio, 5),
              fetchPoolWith("price-asc", 5),
            ]);
          }
          const byId = new Map<string, Offer>();
          for (const branch of branches) {
            for (const o of branch) {
              if (!byId.has(o.offer_id)) {
                byId.set(o.offer_id, o);
              }
            }
          }
          setPoolByDate((prev) => ({ ...prev, [date]: [...byId.values()] }));
        } catch (error: unknown) {
          if (error instanceof Error && error.name === "AbortError") {
            return;
          }
          const msg = error instanceof Error ? error.message : "fetch failed";
          setFetchError(msg);
        } finally {
          poolControllersRef.current.delete(date);
          // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- React setter receives the previous Set value
          setLoadingPoolDates((prev) => {
            if (!prev.has(date)) {
              return prev;
            }
            return new Set([...prev].filter((d) => d !== date));
          });
        }
      })();
    },
    [buildMatchUrl, loadingPoolDates, poolByDate, sortId]
  );

  // Fired when the user clicks a catering chip in the expanded-row picker.
  // Fetches that single catering's offer for that date (limit=1 + include
  // whitelist) and appends to poolByDate so the scatter picks up the new dot.
  const loadCateringForDate = React.useCallback(
    (date: string, companyId: string) => {
      const key = `${date}::${companyId}`;
      // Already loaded as part of the existing pool? skip.
      const existing = poolByDate[date];
      if (existing?.some((o) => o.company_id === companyId)) {
        return;
      }
      if (loadingCaterings.has(key)) {
        return;
      }
      const ctrl = new AbortController();
      cateringControllersRef.current.set(key, ctrl);
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- React setter receives the previous Set value
      setLoadingCaterings((prev) => new Set([...prev, key]));
      void (async () => {
        try {
          const res = await fetch(buildMatchUrl([date], 1, [companyId]), {
            signal: ctrl.signal,
          });
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- shape narrowed at use sites
          const json = (await res.json()) as MatchWeekResponse;
          if (!res.ok) {
            throw new Error(json.error ?? `HTTP ${res.status}`);
          }
          const dayResult = (json.days ?? []).find((d) => d.date === date);
          const newOffer = dayResult?.all_offers[0];
          if (newOffer) {
            setPoolByDate((prev) => {
              const current = prev[date] ?? [];
              // Guard against double-add if two clicks raced; key by offer_id.
              if (current.some((o) => o.offer_id === newOffer.offer_id)) {
                return prev;
              }
              return { ...prev, [date]: [...current, newOffer] };
            });
          }
        } catch (error: unknown) {
          if (error instanceof Error && error.name === "AbortError") {
            return;
          }
          const msg = error instanceof Error ? error.message : "fetch failed";
          setFetchError(msg);
        } finally {
          cateringControllersRef.current.delete(key);
          // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- React setter receives the previous Set value
          setLoadingCaterings((prev) => {
            if (!prev.has(key)) {
              return prev;
            }
            return new Set([...prev].filter((k) => k !== key));
          });
        }
      })();
    },
    [buildMatchUrl, loadingCaterings, poolByDate]
  );

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
          <div className="mt-2.5">
            <ExcludeFilter
              availableCaterings={availableCaterings}
              excludedIds={exclude}
              onChange={setExclude}
            />
          </div>
        </div>
        <SortBar
          activeId={sortId}
          hasPreferences={hasPreferences}
          onChange={handleSortChange}
        />
        {fetchError !== null && (
          <div className="px-5 sm:px-8 lg:px-14 py-2 text-[12px] text-[var(--color-paprika)]">
            nie udało się załadować ofert: {fetchError}
          </div>
        )}
      </div>

      <main className="flex-1">
        <DayByDayListSingle
          availableCaterings={availableCaterings}
          days={days}
          loadingCaterings={loadingCaterings}
          loadingPoolDates={loadingPoolDates}
          onChangeX={setXId}
          onChangeY={setYId}
          onExpandDate={requestPool}
          onLoadCatering={loadCateringForDate}
          poolByDate={poolByDate}
          skeletonDates={skeletonDates}
          sortId={sortId}
          xId={xId}
          yId={yId}
        />
      </main>
    </>
  );
};
