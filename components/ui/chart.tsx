"use client";

import * as React from "react";
import * as RechartsPrimitive from "recharts";

import { cn } from "@/lib/utils";

// ── Config plumbing (shadcn-compatible shape, simplified) ───────────────────

export type ChartConfig = Record<
  string,
  {
    label?: React.ReactNode;
    icon?: React.ComponentType;
    color?: string;
  }
>;

interface ChartContextProps {
  config: ChartConfig;
}

const ChartContext = React.createContext<ChartContextProps | null>(null);

const useChart = () => {
  const ctx = React.useContext(ChartContext);
  if (!ctx) {
    throw new Error("useChart must be used within <ChartContainer>");
  }
  return ctx;
};

// ── ChartStyle: emits CSS variables `--color-{key}` from the config ────────

const ChartStyle = ({ config, id }: { id: string; config: ChartConfig }) => {
  const colorConfig = Object.entries(config).filter(
    ([, c]) => c.color !== undefined && c.color !== ""
  );
  if (!colorConfig.length) {
    return null;
  }
  const css = `[data-chart=${id}] {\n${colorConfig
    .map(([key, item]) => `  --color-${key}: ${item.color};`)
    .join("\n")}\n}`;
  return <style dangerouslySetInnerHTML={{ __html: css }} />;
};

// ── ChartContainer ──────────────────────────────────────────────────────────

const ChartContainer = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div"> & {
    config: ChartConfig;
    children: React.ComponentProps<
      typeof RechartsPrimitive.ResponsiveContainer
    >["children"];
  }
>(({ children, className, config, id, ...props }, ref) => {
  const uniqueId = React.useId();
  const chartId = `chart-${id ?? uniqueId.replaceAll(":", "")}`;

  return (
    <ChartContext.Provider value={{ config }}>
      <div
        className={cn(
          "flex aspect-video justify-center text-xs",
          // Recharts internal styling overrides — keep it quiet.
          "[&_.recharts-cartesian-axis-tick_text]:fill-[var(--color-ink-3)]",
          "[&_.recharts-cartesian-grid_line]:stroke-[var(--color-bone)]",
          "[&_.recharts-cartesian-grid_line]:stroke-[1px]",
          "[&_.recharts-curve.recharts-tooltip-cursor]:stroke-[var(--color-bone)]",
          "[&_.recharts-dot[stroke='#fff']]:stroke-transparent",
          "[&_.recharts-layer]:outline-none",
          "[&_.recharts-sector]:outline-none",
          "[&_.recharts-surface]:outline-none",
          className
        )}
        data-chart={chartId}
        ref={ref}
        {...props}
      >
        <ChartStyle config={config} id={chartId} />
        <RechartsPrimitive.ResponsiveContainer>
          {children}
        </RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
});
ChartContainer.displayName = "Chart";

// ── Tooltip ─────────────────────────────────────────────────────────────────

const ChartTooltip = RechartsPrimitive.Tooltip;

interface PayloadItem {
  value?: number | string;
  name?: string;
  dataKey?: string | number;
  payload?: Record<string, unknown>;
  color?: string;
}

const ChartTooltipContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & {
    active?: boolean;
    payload?: PayloadItem[];
    label?: unknown;
    indicator?: "line" | "dot";
    hideLabel?: boolean;
    labelFormatter?: (
      label: unknown,
      payload: PayloadItem[]
    ) => React.ReactNode;
    formatter?: (value: unknown, name: string) => React.ReactNode;
  }
>(
  (
    {
      active,
      payload,
      label,
      indicator = "dot",
      hideLabel = false,
      labelFormatter,
      formatter,
      className,
    },
    ref
  ) => {
    const { config } = useChart();
    if (active !== true || payload === undefined || payload.length === 0) {
      return null;
    }

    const tooltipLabel = hideLabel ? null : (
      <div className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-3)] mb-1.5">
        {labelFormatter
          ? labelFormatter(label, payload)
          : // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- recharts label is unknown at runtime; consumers pass renderable nodes
            (label as React.ReactNode)}
      </div>
    );

    return (
      <div
        ref={ref}
        className={cn(
          "rounded-md border border-[var(--color-bone)] bg-[var(--color-cream)] px-3 py-2 text-[var(--color-ink)] shadow-[0_8px_24px_-12px_oklch(22%_0.018_60_/_0.18)]",
          className
        )}
      >
        {tooltipLabel}
        <div className="grid gap-1">
          {payload.map((item, idx) => {
            const key = `${item.dataKey ?? item.name ?? "value"}`;
            const conf = config[key];
            const indicatorColor = item.color ?? `var(--color-${key})`;
            return (
              <div
                key={`${key}-${idx}`}
                className="flex items-center gap-2 text-[13px] tnum"
              >
                {indicator === "line" ? (
                  <span
                    className="h-px w-3"
                    style={{ background: indicatorColor }}
                  />
                ) : (
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ background: indicatorColor }}
                  />
                )}
                <span className="text-[var(--color-ink-2)]">
                  {conf?.label ?? item.name ?? key}
                </span>
                <span className="ml-auto font-medium text-[var(--color-ink)]">
                  {formatter
                    ? formatter(item.value, item.name ?? "")
                    : (item.value as React.ReactNode)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }
);
ChartTooltipContent.displayName = "ChartTooltipContent";

// ── Legend (kept minimal — not used in v1 but exported for parity) ─────────

const ChartLegend = RechartsPrimitive.Legend;

const ChartLegendContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { payload?: PayloadItem[] }
>(({ className, payload }, ref) => {
  if (payload === undefined || payload.length === 0) {
    return null;
  }
  return (
    <div
      ref={ref}
      className={cn("flex items-center justify-center gap-4 pt-3", className)}
    >
      {payload.map((item) => (
        <div
          key={String(item.dataKey ?? item.name)}
          className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-3)]"
        >
          <span
            className="h-2 w-2 rounded-full"
            style={{ background: item.color }}
          />
          {item.name}
        </div>
      ))}
    </div>
  );
});
ChartLegendContent.displayName = "ChartLegendContent";

export {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  ChartStyle,
};
