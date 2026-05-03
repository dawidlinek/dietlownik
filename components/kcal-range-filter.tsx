"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import * as React from "react";

import { cn } from "@/lib/utils";

interface Props {
  /** Hard data bounds — what's actually in the DB for this city. */
  readonly dataMin: number;
  readonly dataMax: number;
  /** Quick-pick chips with confirmed data, e.g. [1200, 1500, 1800, 2000, 2500]. */
  readonly presets: readonly number[];
  /** Currently selected range. */
  readonly activeMin: number;
  readonly activeMax: number;
  /** Day-length pills shown next to the range so the whole filter row is one strip. */
  readonly dayOptions: readonly number[];
  readonly activeDays: number;
}

const URL_DEBOUNCE_MS = 200;

const clamp = (n: number, lo: number, hi: number): number => {
  if (Number.isNaN(n)) {
    return lo;
  }
  return Math.max(lo, Math.min(hi, n));
};

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- React.ReactNode union recursively includes mutable Iterable<ReactNode>; cannot be made deeply readonly
const Pill = ({
  active,
  children,
  onClick,
  title,
}: Readonly<{
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}>) => (
  <button
    aria-pressed={active}
    className={cn(
      "rounded-full px-3 py-1 text-[13px] tnum transition-colors",
      active
        ? "bg-[var(--color-amber-tint)] text-[var(--color-ink)]"
        : "bg-transparent text-[var(--color-ink-2)] hover:bg-[var(--color-oat)]"
    )}
    onClick={onClick}
    title={title}
    type="button"
  >
    {children}
  </button>
);

const NumberCell = ({
  ariaLabel,
  onChange,
  value,
}: Readonly<{
  value: string;
  onChange: (v: string) => void;
  ariaLabel: string;
}>) => (
  <input
    aria-label={ariaLabel}
    className={cn(
      "w-[68px] px-2 py-1 text-[14px] tnum text-right",
      "bg-[var(--color-oat)] text-[var(--color-ink)]",
      "border border-transparent rounded-md",
      "focus:outline-none focus:border-[var(--color-amber)] focus:bg-white"
    )}
    inputMode="numeric"
    onChange={
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- React.ChangeEvent has DOM refs (target/currentTarget) that cannot be deeply readonly
      (e) => {
        onChange(e.target.value);
      }
    }
    pattern="[0-9]*"
    type="number"
    value={value}
  />
);

export const KcalRangeFilter = ({
  activeDays,
  activeMax,
  activeMin,
  dataMax,
  dataMin,
  dayOptions,
  presets,
}: Readonly<Props>) => {
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
    (patch: Readonly<Record<string, string | number | undefined>>) => {
      const sp = new URLSearchParams(searchParams.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) {
          sp.delete(k);
        } else {
          sp.set(k, String(v));
        }
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
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
      }
      debounceRef.current = window.setTimeout(() => {
        let mn = clamp(Number.parseInt(rawMin, 10), dataMin, dataMax);
        let mx = clamp(Number.parseInt(rawMax, 10), dataMin, dataMax);
        if (Number.isNaN(Number.parseInt(rawMin, 10))) {
          mn = activeMin;
        }
        if (Number.isNaN(Number.parseInt(rawMax, 10))) {
          mx = activeMax;
        }
        if (mn > mx) {
          [mn, mx] = [mx, mn];
        }
        setUrl({ kcal_max: mx, kcal_min: mn });
      }, URL_DEBOUNCE_MS);
    },
    [activeMin, activeMax, dataMin, dataMax, setUrl]
  );

  const onPreset = (k: number) => {
    setMinStr(String(k));
    setMaxStr(String(k));
    setUrl({ kcal_max: k, kcal_min: k });
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
            ariaLabel="Minimalna kaloryczność"
            onChange={(v) => {
              setMinStr(v);
              commit(v, maxStr);
            }}
            value={minStr}
          />
          <span aria-hidden className="text-[var(--color-ink-3)]">
            –
          </span>
          <NumberCell
            ariaLabel="Maksymalna kaloryczność"
            onChange={(v) => {
              setMaxStr(v);
              commit(minStr, v);
            }}
            value={maxStr}
          />
          {showRangeReset && (
            <button
              className="text-[12px] text-[var(--color-ink-3)] hover:text-[var(--color-ink)] underline-offset-2 hover:underline ml-1"
              onClick={() => {
                setMinStr(String(dataMin));
                setMaxStr(String(dataMax));
                setUrl({ kcal_max: dataMax, kcal_min: dataMin });
              }}
              type="button"
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
                active={isActive}
                key={k}
                onClick={() => {
                  onPreset(k);
                }}
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
              active={d === activeDays}
              key={d}
              onClick={() => {
                setUrl({ days: d });
              }}
              title={
                d === 1
                  ? "Cena bez rabatu długościowego"
                  : `${d} dni — z rabatem`
              }
            >
              {d}
            </Pill>
          ))}
        </div>
      </div>
    </div>
  );
};
