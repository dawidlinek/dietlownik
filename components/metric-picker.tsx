"use client";

import * as React from "react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { METRICS } from "@/lib/scatter-metrics";
import type { Metric, MetricId } from "@/lib/scatter-metrics";
import { cn } from "@/lib/utils";

export interface MetricPickerProps {
  /** Axis name shown as the eyebrow (e.g. "X", "Y"). */
  readonly axis: string;
  readonly value: MetricId;
  readonly onChange: (id: MetricId) => void;
  /** A second metric to disable in the list (e.g. the OTHER axis). */
  readonly disabledId?: MetricId;
}

export const MetricPicker = ({
  axis,
  disabledId,
  onChange,
  value,
}: Readonly<MetricPickerProps>) => {
  const [open, setOpen] = React.useState(false);
  const current = METRICS.find((m) => m.id === value);

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "inline-flex items-baseline gap-1.5 px-2 py-1 rounded-sm",
            "text-[12px] text-[var(--color-ink-2)]",
            "hover:bg-[var(--color-oat)] transition-colors"
          )}
          type="button"
        >
          <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--color-ink-3)]">
            {axis}
          </span>
          <span className="text-[var(--color-ink)]">{current?.label}</span>
          {current && current.unit !== "" && (
            <span className="text-[var(--color-ink-3)]">· {current.unit}</span>
          )}
          <span
            aria-hidden
            className="text-[9px] text-[var(--color-ink-3)] leading-none"
          >
            ▾
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[200px] p-1">
        <div className="px-2 py-1 text-[10px] uppercase tracking-[0.08em] text-[var(--color-ink-3)]">
          oś {axis}
        </div>
        {METRICS.map((m: Metric) => {
          const disabled = m.id === disabledId;
          const selected = m.id === value;
          return (
            <button
              aria-pressed={selected}
              className={cn(
                "w-full text-left px-2.5 py-1.5 rounded-sm text-[12px]",
                "flex items-baseline justify-between gap-2",
                "transition-colors",
                disabled && "opacity-40 cursor-not-allowed",
                !disabled && selected && "bg-[var(--color-amber-tint)]",
                !disabled && !selected && "hover:bg-[var(--color-oat)]"
              )}
              disabled={disabled}
              key={m.id}
              onClick={() => {
                onChange(m.id);
                setOpen(false);
              }}
              type="button"
            >
              <span className="text-[var(--color-ink)]">{m.label}</span>
              <span className="text-[10px] text-[var(--color-ink-3)]">
                {m.unit || "—"}
              </span>
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
};
