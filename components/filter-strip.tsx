"use client";

import * as React from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

export interface FilterStripProps {
  kcalOptions: number[];
  dayOptions: number[];
  activeKcal: number;
  activeDays: number;
  summary: {
    companies: number;
    pricedRows: number;
    activeCampaigns: number;
  };
}

function useUrlSetter() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return React.useCallback(
    (patch: Record<string, string | number | undefined>) => {
      const sp = new URLSearchParams(searchParams.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) sp.delete(k);
        else sp.set(k, String(v));
      }
      router.push(`${pathname}?${sp.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams]
  );
}

function Pill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full px-3.5 py-1.5 text-[13px] tnum transition-colors",
        active
          ? "bg-[var(--color-amber-tint)] text-[var(--color-ink)]"
          : "bg-transparent text-[var(--color-ink-2)] hover:bg-[var(--color-oat)]"
      )}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}

export function FilterStrip({
  kcalOptions,
  dayOptions,
  activeKcal,
  activeDays,
  summary,
}: FilterStripProps) {
  const setUrl = useUrlSetter();

  return (
    <div className="px-5 sm:px-8 lg:px-14 py-6 border-b border-[var(--color-bone)]">
      <div className="text-[13px] text-[var(--color-ink-3)] mb-3">
        <span>{summary.companies} firm</span>
        <span aria-hidden className="mx-2 text-[var(--color-bone)]">·</span>
        <span>{summary.pricedRows} ofert</span>
        <span aria-hidden className="mx-2 text-[var(--color-bone)]">·</span>
        <span>
          {summary.activeCampaigns === 0
            ? "0 promocji aktywnych"
            : `${summary.activeCampaigns} promocji aktywnych`}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-3)] mr-2">
            Kcal
          </span>
          {kcalOptions.map((k) => (
            <Pill
              key={k}
              active={k === activeKcal}
              onClick={() => setUrl({ kcal: k })}
            >
              {k}
            </Pill>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-3)] mr-2">
            Dni
          </span>
          {dayOptions.map((d) => (
            <Pill
              key={d}
              active={d === activeDays}
              onClick={() => setUrl({ days: d })}
            >
              {d} dni
            </Pill>
          ))}
        </div>
      </div>
    </div>
  );
}
