"use client";

import * as React from "react";

import { SORT_OPTIONS } from "@/lib/sort-metrics";
import type { SortId } from "@/lib/sort-metrics";
import { cn } from "@/lib/utils";

interface Props {
  readonly activeId: SortId;
  readonly onChange: (id: SortId) => void;
}

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

export const SortBar = ({ activeId, onChange }: Readonly<Props>) => {
  const basics = SORT_OPTIONS.filter((s) => s.group === "basic");
  const ratios = SORT_OPTIONS.filter((s) => s.group === "ratio");

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
