"use client";

import { weekdayShortPl } from "@/lib/match-types";

const formatDayMonth = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00`);
  return new Intl.DateTimeFormat("pl-PL", {
    day: "numeric",
    month: "short",
  }).format(d);
};

interface DayRowSkeletonProps {
  /** ISO yyyy-mm-dd. Date column stays real so the page never jumps. */
  readonly date: string;
}

/**
 * Shimmer placeholder matching the `SingleRow` grid in
 * `day-by-day-list-single.tsx`. Rendered for every selected date while
 * Phase A (the top-1 per-day fetch) is in flight after a filter change.
 */
export const DayRowSkeleton = ({ date }: Readonly<DayRowSkeletonProps>) => (
  <div className="grid grid-cols-1 md:grid-cols-[110px_1fr] gap-x-8 gap-y-4 py-7 border-t border-[var(--color-bone)] first:border-t-0">
    <div className="md:pt-1">
      <div className="text-[12px] uppercase tracking-[0.1em] text-[var(--color-ink-3)]">
        {weekdayShortPl(date)}
      </div>
      <div className="font-display text-[22px] leading-tight text-[var(--color-ink)] tnum">
        {formatDayMonth(date)}
      </div>
      <div className="mt-2 h-2.5 w-12 rounded-sm bg-[var(--color-bone)] animate-pulse" />
    </div>

    <div className="flex flex-col gap-1.5 py-1 -mx-2 px-2 rounded-sm">
      <div className="flex items-baseline justify-between gap-3">
        <div className="h-2.5 w-20 rounded-sm bg-[var(--color-bone)] animate-pulse" />
        <div className="flex items-baseline gap-2">
          <div className="h-2.5 w-16 rounded-sm bg-[var(--color-bone)] animate-pulse" />
          <div className="h-3.5 w-14 rounded-sm bg-[var(--color-bone)] animate-pulse" />
        </div>
      </div>

      <div className="flex items-center gap-2 pt-0.5">
        <div className="h-3 w-32 rounded-sm bg-[var(--color-bone)] animate-pulse" />
        <div className="h-3 w-1 rounded-sm bg-[var(--color-bone)]/60" />
        <div className="h-3 w-24 rounded-sm bg-[var(--color-bone)] animate-pulse" />
        <div className="h-3 w-1 rounded-sm bg-[var(--color-bone)]/60" />
        <div className="h-3 w-14 rounded-sm bg-[var(--color-bone)] animate-pulse" />
      </div>

      <div className="flex items-baseline gap-3 pt-0.5">
        <div className="h-5 w-24 rounded-sm bg-[var(--color-bone)] animate-pulse" />
        <div className="h-3 w-12 rounded-sm bg-[var(--color-bone)] animate-pulse" />
        <div className="h-3 w-20 rounded-sm bg-[var(--color-amber-tint)] animate-pulse" />
      </div>

      <div className="flex items-center gap-4 pt-0.5">
        <div className="h-3 w-16 rounded-sm bg-[var(--color-bone)] animate-pulse" />
        <div className="h-3 w-48 rounded-sm bg-[var(--color-bone)] animate-pulse" />
        <div className="ml-auto h-2.5 w-20 rounded-sm bg-[var(--color-bone)] animate-pulse" />
      </div>
    </div>
  </div>
);
