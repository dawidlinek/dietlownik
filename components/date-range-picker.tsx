"use client";

import * as React from "react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const formatLongDate = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00`);
  return new Intl.DateTimeFormat("pl-PL", {
    day: "numeric",
    month: "short",
  }).format(d);
};

const weekdayShort = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00`);
  // Polish short weekdays: pon, wt, śr, czw, pt, sob, nd
  // JS Date.getDay(): 0=Sun, 1=Mon... → map to 0=Mon, 6=Sun
  const idx = (d.getDay() + 6) % 7;
  return ["pon", "wt", "śr", "czw", "pt", "sob", "nd"][idx];
};

const isWeekend = (iso: string): boolean => {
  const d = new Date(`${iso}T00:00:00`);
  const dow = d.getDay();
  return dow === 0 || dow === 6;
};

interface DayCellProps {
  readonly iso: string;
  readonly selected: boolean;
  readonly onToggle: () => void;
}

const DayCell = ({ iso, onToggle, selected }: Readonly<DayCellProps>) => (
  <button
    aria-pressed={selected}
    className={cn(
      "flex flex-col items-center justify-center rounded-sm py-1 px-1.5 transition-colors",
      "border min-w-[40px]",
      selected
        ? "bg-[var(--color-amber-tint)] border-[var(--color-amber)] text-[var(--color-ink)]"
        : "bg-transparent border-dashed border-[var(--color-bone)] text-[var(--color-ink-3)] hover:border-[var(--color-ink-3)]"
    )}
    onClick={onToggle}
    title={iso}
    type="button"
  >
    <span className="text-[9px] uppercase tracking-[0.06em] leading-none">
      {weekdayShort(iso)}
    </span>
    <span className="font-display tnum text-[14px] leading-tight mt-0.5">
      {formatLongDate(iso)}
    </span>
  </button>
);

export interface DateRangePickerProps {
  /** All dates the picker can offer (the data window). */
  readonly availableDates: readonly string[];
  /** Subset currently selected. */
  readonly selectedDates: readonly string[];
  readonly onChange: (next: readonly string[]) => void;
  /** Custom trigger element; defaults to the labelled "Daty" button. */
  readonly trigger?: React.ReactElement;
}

const summarizeRange = (selected: readonly string[], total: number): string => {
  if (selected.length === 0) {
    return "brak dat";
  }
  if (selected.length === total) {
    return `${total} dni · ${formatLongDate(selected[0])} → ${formatLongDate(selected.at(-1) ?? "")}`;
  }
  return `${selected.length} z ${total} dni · ${formatLongDate(selected[0])} → ${formatLongDate(selected.at(-1) ?? "")}`;
};

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- `trigger` is a ReactElement, whose props type cannot be made deeply readonly
export const DateRangePicker = ({
  availableDates,
  onChange,
  selectedDates,
  trigger,
}: Readonly<DateRangePickerProps>) => {
  const selectedSet = new Set(selectedDates);

  const toggle = (iso: string) => {
    const next = new Set(selectedSet);
    if (next.has(iso)) {
      next.delete(iso);
    } else {
      next.add(iso);
    }
    // Keep result in the original calendar order.
    onChange(availableDates.filter((d) => next.has(d)));
  };

  const selectAll = () => {
    onChange(availableDates);
  };
  const selectWeekdaysOnly = () => {
    onChange(availableDates.filter((d) => !isWeekend(d)));
  };
  const clear = () => {
    onChange([]);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        {trigger ?? (
          <button
            className={cn(
              "group inline-flex items-center gap-2 px-2 py-1 text-[14px] text-[var(--color-ink)] rounded-sm",
              "hover:bg-[var(--color-oat)] transition-colors"
            )}
            type="button"
          >
            <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-3)]">
              Daty
            </span>
            <span className="font-medium tnum text-[13px]">
              {summarizeRange(selectedDates, availableDates.length)}
            </span>
            <span
              aria-hidden
              className="text-[var(--color-ink-3)] text-[12px] leading-none"
            >
              ↓
            </span>
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[360px] p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--color-ink-3)]">
            wybierz dni
          </div>
          <div className="flex items-center gap-2 text-[11px]">
            <button
              className="text-[var(--color-ink-3)] hover:text-[var(--color-ink)] underline-offset-2 hover:underline"
              onClick={selectAll}
              type="button"
            >
              wszystkie
            </button>
            <span aria-hidden className="text-[var(--color-ink-3)]/40">
              ·
            </span>
            <button
              className="text-[var(--color-ink-3)] hover:text-[var(--color-ink)] underline-offset-2 hover:underline"
              onClick={selectWeekdaysOnly}
              type="button"
            >
              tylko robocze
            </button>
            <span aria-hidden className="text-[var(--color-ink-3)]/40">
              ·
            </span>
            <button
              className="text-[var(--color-ink-3)] hover:text-[var(--color-ink)] underline-offset-2 hover:underline"
              onClick={clear}
              type="button"
            >
              wyczyść
            </button>
          </div>
        </div>

        <div className="flex flex-wrap gap-1">
          {availableDates.map((iso) => (
            <DayCell
              iso={iso}
              key={iso}
              onToggle={() => {
                toggle(iso);
              }}
              selected={selectedSet.has(iso)}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
};
