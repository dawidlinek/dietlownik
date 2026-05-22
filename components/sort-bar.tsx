"use client";

import * as React from "react";

import { SORT_OPTIONS } from "@/lib/sort-metrics";
import type { SortId } from "@/lib/sort-metrics";
import { cn } from "@/lib/utils";

interface Props {
  readonly activeId: SortId;
  readonly onChange: (id: SortId) => void;
  /** False when no prefer/avoid filters are set — score-derived chips become
   *  pure noise (every score is 0) so we hide them. */
  readonly hasPreferences: boolean;
}

/** Sort chips that derive their ranking from the prefer/avoid score signal. */
const SCORE_DEPENDENT_SORTS: ReadonlySet<SortId> = new Set([
  "score-desc",
  "score-per-zl",
]);

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- React.ReactNode union recursively includes mutable Iterable<ReactNode>; cannot be made deeply readonly
const Chip = ({
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
      "rounded-full px-3 py-1 text-[13px] tnum transition-colors whitespace-nowrap",
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

const ArrowGlyph = ({ direction }: Readonly<{ direction: "asc" | "desc" }>) => (
  <span
    aria-hidden
    className="ml-1 text-[10px] text-[var(--color-ink-3)] inline-block"
  >
    {direction === "asc" ? "↑" : "↓"}
  </span>
);

export const SortBar = ({
  activeId,
  hasPreferences,
  onChange,
}: Readonly<Props>) => {
  const visible = SORT_OPTIONS.filter(
    (s) => hasPreferences || !SCORE_DEPENDENT_SORTS.has(s.id)
  );
  const basics = visible.filter((s) => s.group === "basic");
  const ratios = visible.filter((s) => s.group === "ratio");
  const macros = visible.filter((s) => s.group === "macro");

  // Auto-expand when an active macro sort comes in from persisted state so the
  // user can see what's selected without hunting for it.
  const macroActive = macros.some((s) => s.id === activeId);
  const [macrosOpen, setMacrosOpen] = React.useState(macroActive);
  React.useEffect(() => {
    if (macroActive) {
      setMacrosOpen(true);
    }
  }, [macroActive]);

  return (
    <div
      aria-label="Sortuj oferty"
      className="px-5 sm:px-8 lg:px-14 py-3 border-b border-[var(--color-bone)] flex flex-wrap items-center gap-x-5 gap-y-2"
    >
      <div className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-ink-3)] mr-1">
        sortuj
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {basics.map((s) => (
          <Chip
            active={activeId === s.id}
            key={s.id}
            onClick={() => {
              onChange(s.id);
            }}
            title={s.hint}
          >
            {s.short}
            <ArrowGlyph direction={s.direction} />
          </Chip>
        ))}
        <button
          aria-expanded={macrosOpen}
          aria-label={
            macrosOpen
              ? "Schowaj sortowanie po makro"
              : "Pokaż sortowanie po makro"
          }
          className={cn(
            "rounded-full px-2.5 py-1 text-[13px] transition-colors whitespace-nowrap",
            "text-[var(--color-ink-3)] hover:bg-[var(--color-oat)] hover:text-[var(--color-ink-2)]",
            macroActive && "text-[var(--color-ink-2)]"
          )}
          onClick={() => {
            setMacrosOpen((v) => !v);
          }}
          title="sortuj po makro"
          type="button"
        >
          <span aria-hidden>{macrosOpen ? "×" : "⋯"}</span>
        </button>
        {macrosOpen &&
          macros.map((s) => (
            <Chip
              active={activeId === s.id}
              key={s.id}
              onClick={() => {
                onChange(s.id);
              }}
              title={s.hint}
            >
              {s.short}
              <ArrowGlyph direction={s.direction} />
            </Chip>
          ))}
      </div>

      <span aria-hidden className="text-[var(--color-ink-3)]/40 select-none">
        ·
      </span>

      <div className="flex flex-wrap items-center gap-1">
        <span className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-ink-3)] mr-1">
          wartość za zł
        </span>
        {ratios.map((s) => (
          <Chip
            active={activeId === s.id}
            key={s.id}
            onClick={() => {
              onChange(s.id);
            }}
            title={s.hint}
          >
            {s.short}
            <ArrowGlyph direction={s.direction} />
          </Chip>
        ))}
      </div>
    </div>
  );
};
