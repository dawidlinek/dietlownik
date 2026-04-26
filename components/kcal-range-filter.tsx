"use client";

import * as React from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

interface Props {
  /** Hard data bounds — what's actually in the DB for this city. */
  dataMin: number;
  dataMax: number;
  /** Quick-pick chips with confirmed data, e.g. [1200, 1500, 1800, 2000, 2500]. */
  presets: number[];
  /** Currently selected range. */
  activeMin: number;
  activeMax: number;
  /** Day-length pills shown next to the range so the whole filter row is one strip. */
  dayOptions: number[];
  activeDays: number;
}

const URL_DEBOUNCE_MS = 200;

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

export function KcalRangeFilter({
  dataMin,
  dataMax,
  presets,
  activeMin,
  activeMax,
  dayOptions,
  activeDays,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [minStr, setMinStr] = React.useState(String(activeMin));
  const [maxStr, setMaxStr] = React.useState(String(activeMax));

  // Re-sync local state when URL changes externally (back/forward).
  React.useEffect(() => {
    setMinStr(String(activeMin));
    setMaxStr(String(activeMax));
  }, [activeMin, activeMax]);

  const setUrl = React.useCallback(
    (patch: Record<string, string | number | undefined>) => {
      const sp = new URLSearchParams(searchParams.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) sp.delete(k);
        else sp.set(k, String(v));
      }
      // First page on filter change.
      sp.delete("page");
      router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams]
  );

  // Debounced commit of the typed range.
  const debounceRef = React.useRef<number | null>(null);
  const commit = React.useCallback(
    (rawMin: string, rawMax: string) => {
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => {
        let mn = clamp(parseInt(rawMin, 10), dataMin, dataMax);
        let mx = clamp(parseInt(rawMax, 10), dataMin, dataMax);
        if (Number.isNaN(parseInt(rawMin, 10))) mn = activeMin;
        if (Number.isNaN(parseInt(rawMax, 10))) mx = activeMax;
        if (mn > mx) [mn, mx] = [mx, mn];
        setUrl({ kcal_min: mn, kcal_max: mx });
      }, URL_DEBOUNCE_MS);
    },
    [activeMin, activeMax, dataMin, dataMax, setUrl]
  );

  const onPreset = (k: number) => {
    setMinStr(String(k));
    setMaxStr(String(k));
    setUrl({ kcal_min: k, kcal_max: k });
  };

  const showRangeReset =
    activeMin > dataMin || activeMax < dataMax || activeMin === activeMax;

  return (
    <div className="px-5 sm:px-8 lg:px-14 py-5 border-b border-[var(--color-bone)]">
      <div className="flex flex-wrap items-center gap-x-7 gap-y-4">
        {/* Range inputs */}
        <div className="flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-3)] mr-1">
            Kcal
          </span>
          <NumberCell
            value={minStr}
            onChange={(v) => {
              setMinStr(v);
              commit(v, maxStr);
            }}
            ariaLabel="Minimalna kaloryczność"
          />
          <span aria-hidden className="text-[var(--color-ink-3)]">
            –
          </span>
          <NumberCell
            value={maxStr}
            onChange={(v) => {
              setMaxStr(v);
              commit(minStr, v);
            }}
            ariaLabel="Maksymalna kaloryczność"
          />
          {showRangeReset && (
            <button
              type="button"
              onClick={() => {
                setMinStr(String(dataMin));
                setMaxStr(String(dataMax));
                setUrl({ kcal_min: dataMin, kcal_max: dataMax });
              }}
              className="text-[12px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] underline-offset-2 hover:underline ml-1"
            >
              cały zakres
            </button>
          )}
        </div>

        {/* Presets */}
        <div className="flex items-center gap-1">
          {presets.map((k) => {
            const isActive = activeMin === k && activeMax === k;
            return (
              <Pill
                key={k}
                active={isActive}
                onClick={() => onPreset(k)}
                title={`${k} kcal — kliknij, by zawęzić`}
              >
                {k}
              </Pill>
            );
          })}
        </div>

        {/* Days */}
        <div className="flex items-center gap-1">
          <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-3)] mr-1">
            Dni
          </span>
          {dayOptions.map((d) => (
            <Pill
              key={d}
              active={d === activeDays}
              onClick={() => setUrl({ days: d })}
              title={d === 1 ? "Cena bez rabatu długościowego" : `${d} dni — z rabatem`}
            >
              {d}
            </Pill>
          ))}
        </div>
      </div>
    </div>
  );
}

function Pill({
  active,
  onClick,
  children,
  title,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={cn(
        "rounded-full px-3 py-1 text-[13px] tnum transition-colors",
        active
          ? "bg-[var(--color-amber-tint)] text-[var(--color-ink)]"
          : "bg-transparent text-[var(--color-ink-2)] hover:bg-[var(--color-oat)]"
      )}
    >
      {children}
    </button>
  );
}

function NumberCell({
  value,
  onChange,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  ariaLabel: string;
}) {
  return (
    <input
      type="number"
      inputMode="numeric"
      pattern="[0-9]*"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={ariaLabel}
      className={cn(
        "w-[68px] px-2 py-1 text-[14px] tnum text-right",
        "bg-[var(--color-oat)] text-[var(--color-ink)]",
        "border border-transparent rounded-md",
        "focus:outline-none focus:border-[var(--color-amber)] focus:bg-white"
      )}
    />
  );
}
