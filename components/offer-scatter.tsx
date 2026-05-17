"use client";

import * as React from "react";
import {
  CartesianGrid,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { MetricPicker } from "@/components/metric-picker";
import { ChartContainer } from "@/components/ui/chart";
import type { ChartConfig } from "@/components/ui/chart";
import type { MockOffer } from "@/lib/mock-match-data";
import type { Metric, MetricId } from "@/lib/scatter-metrics";

const chartConfig = {
  offer: { color: "var(--color-ink-2)", label: "Oferta" },
} satisfies ChartConfig;

interface ScatterPoint {
  readonly offer_id: string;
  readonly x: number;
  readonly y: number;
  readonly company_name: string;
  readonly diet_name: string;
  readonly tier_name: string | null;
  readonly calories: number;
  readonly is_menu_configuration: boolean;
  /** Raw price + score kept for the tooltip body, even when off-axis. */
  readonly price: number;
  readonly score: number;
}

const toPoint = (o: MockOffer, xM: Metric, yM: Metric): ScatterPoint => ({
  calories: o.calories,
  company_name: o.company_name,
  diet_name: o.diet_name,
  is_menu_configuration: o.is_menu_configuration,
  offer_id: o.offer_id,
  price: o.price_per_day,
  score: o.score_best,
  tier_name: o.tier_name,
  x: xM.accessor(o),
  y: yM.accessor(o),
});

const scoreColorClass = (v: number): string => {
  if (v > 0.05) {
    return "text-[var(--color-olive)]";
  }
  if (v < -0.05) {
    return "text-[var(--color-clay)]";
  }
  return "text-[var(--color-ink-3)]";
};

interface TooltipBodyProps {
  readonly point: ScatterPoint;
  readonly xMetric: Metric;
  readonly yMetric: Metric;
}

const TooltipBody = ({
  point,
  xMetric,
  yMetric,
}: Readonly<TooltipBodyProps>) => {
  const scoreColor = scoreColorClass(point.score);
  return (
    <div className="rounded-md border border-[var(--color-bone)] bg-[var(--color-cream)] px-3 py-2 shadow-[0_8px_24px_-12px_oklch(22%_0.018_60_/_0.18)]">
      <div className="text-[13px] font-medium text-[var(--color-ink)]">
        {point.company_name}
      </div>
      <div className="text-[12px] text-[var(--color-ink-2)]">
        {point.diet_name}
        {point.tier_name !== null && point.tier_name !== "" && (
          <>
            <span className="text-[var(--color-ink-3)]"> · </span>
            <span>{point.tier_name}</span>
          </>
        )}
        <span className="text-[var(--color-ink-3)]"> · </span>
        <span className="tnum">{point.calories} kcal</span>
        {point.is_menu_configuration && (
          <span className="ml-1.5 text-[10px] uppercase tracking-[0.08em] text-[var(--color-ink-3)]">
            menu config
          </span>
        )}
      </div>
      <div className="mt-1.5 flex flex-col gap-0.5 text-[12px]">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--color-ink-3)]">
            {xMetric.label}
          </span>
          <span className="tnum text-[var(--color-ink)]">
            {xMetric.format(point.x)}
            {xMetric.unit && (
              <span className="text-[var(--color-ink-3)] ml-1">
                {xMetric.unit}
              </span>
            )}
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--color-ink-3)]">
            {yMetric.label}
          </span>
          <span
            className={`tnum ${yMetric.id === "score" || yMetric.id === "score_default" ? scoreColor : "text-[var(--color-ink)]"}`}
          >
            {yMetric.format(point.y)}
            {yMetric.unit && (
              <span className="text-[var(--color-ink-3)] ml-1">
                {yMetric.unit}
              </span>
            )}
          </span>
        </div>
      </div>
      <div className="mt-1 text-[11px] italic text-[var(--color-ink-3)]">
        kliknij, aby wybrać
      </div>
    </div>
  );
};

interface DotShapeProps {
  readonly cx?: number;
  readonly cy?: number;
  readonly fill?: string;
  readonly stroke?: string;
  readonly strokeWidth?: number;
  readonly r?: number;
}

const Dot = ({
  cx,
  cy,
  fill,
  r = 5,
  stroke,
  strokeWidth = 0,
}: Readonly<DotShapeProps>) => {
  if (cx === undefined || cy === undefined) {
    return null;
  }
  return (
    <circle
      cx={cx}
      cy={cy}
      fill={fill ?? "var(--color-ink-3)"}
      r={r}
      stroke={stroke ?? "none"}
      strokeWidth={strokeWidth}
    />
  );
};

const tooltipCursor = {
  stroke: "var(--color-bone)",
  strokeDasharray: "2 4",
};

export interface OfferScatterProps {
  readonly offers: readonly MockOffer[];
  readonly cheapestId: string;
  readonly selectedId: string;
  readonly onPick: (offerId: string) => void;
  readonly xMetric: Metric;
  readonly yMetric: Metric;
  readonly onChangeX: (id: MetricId) => void;
  readonly onChangeY: (id: MetricId) => void;
}

export const OfferScatter = ({
  cheapestId,
  offers,
  onChangeX,
  onChangeY,
  onPick,
  selectedId,
  xMetric,
  yMetric,
}: Readonly<OfferScatterProps>) => {
  const points = React.useMemo(
    () => offers.map((o) => toPoint(o, xMetric, yMetric)),
    [offers, xMetric, yMetric]
  );
  const cheapest = points.filter((p) => p.offer_id === cheapestId);
  const selected = points.filter(
    (p) => p.offer_id === selectedId && p.offer_id !== cheapestId
  );
  const others = points.filter(
    (p) => p.offer_id !== cheapestId && p.offer_id !== selectedId
  );

  // Axis padding scaled to value range.
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const xRange = Math.max(...xs) - Math.min(...xs);
  const yRange = Math.max(...ys) - Math.min(...ys);
  const xPad = Math.max(xRange * 0.05, 1);
  const yPad = Math.max(yRange * 0.05, 0.5);
  const minX = Math.min(...xs) - xPad;
  const maxX = Math.max(...xs) + xPad;
  const minY = Math.min(...ys) - yPad;
  const maxY = Math.max(...ys) + yPad;

  const handleClick = (data: Readonly<{ offer_id?: string }>) => {
    if (typeof data.offer_id === "string") {
      onPick(data.offer_id);
    }
  };

  const renderTooltip = ({
    active,
    payload,
  }: Readonly<{
    active?: boolean;
    payload?: readonly Readonly<{ payload?: ScatterPoint }>[];
  }>) => {
    if (active !== true || !payload || payload.length === 0) {
      return null;
    }
    const point = payload[0]?.payload;
    if (!point) {
      return null;
    }
    return <TooltipBody point={point} xMetric={xMetric} yMetric={yMetric} />;
  };

  return (
    <div>
      <div className="relative pl-9">
        {/* Y-axis picker — rotated to read bottom-to-top, sits where Recharts' label would */}
        <div className="absolute inset-y-0 left-0 z-10 w-9 flex items-center justify-center">
          <div className="-rotate-90 whitespace-nowrap">
            <MetricPicker
              axis="Y"
              disabledId={xMetric.id}
              onChange={onChangeY}
              value={yMetric.id}
            />
          </div>
        </div>

        <ChartContainer
          className="aspect-auto h-[260px] w-full"
          config={chartConfig}
        >
          <ScatterChart margin={{ bottom: 6, left: 8, right: 12, top: 6 }}>
            <CartesianGrid stroke="var(--color-bone)" strokeDasharray="2 4" />
            <XAxis
              axisLine={false}
              dataKey="x"
              domain={[minX, maxX]}
              tickFormatter={(v: number) => xMetric.format(v)}
              tickLine={false}
              tickMargin={6}
              type="number"
            />
            <YAxis
              axisLine={false}
              dataKey="y"
              domain={[minY, maxY]}
              tickFormatter={(v: number) => yMetric.format(v)}
              tickLine={false}
              tickMargin={6}
              type="number"
              width={56}
            />
            <Tooltip content={renderTooltip} cursor={tooltipCursor} />
            <Scatter
              cursor="pointer"
              data={others}
              isAnimationActive={false}
              onClick={handleClick}
              shape={<Dot fill="var(--color-ink-3)" r={4} />}
            />
            <Scatter
              cursor="pointer"
              data={cheapest}
              isAnimationActive={false}
              onClick={handleClick}
              shape={
                <Dot
                  fill="var(--color-cream)"
                  r={6}
                  stroke="var(--color-olive)"
                  strokeWidth={2}
                />
              }
            />
            <Scatter
              cursor="pointer"
              data={selected}
              isAnimationActive={false}
              onClick={handleClick}
              shape={
                <Dot
                  fill="var(--color-amber)"
                  r={6}
                  stroke="var(--color-cream)"
                  strokeWidth={2}
                />
              }
            />
          </ScatterChart>
        </ChartContainer>
      </div>

      {/* X-axis picker — replaces the label, centered below the chart */}
      <div className="mt-1 flex justify-center">
        <MetricPicker
          axis="X"
          disabledId={yMetric.id}
          onChange={onChangeX}
          value={xMetric.id}
        />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] text-[var(--color-ink-3)]">
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block w-3 h-3 rounded-full border-2 border-[var(--color-olive)] bg-[var(--color-cream)]"
          />
          najtańsza
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block w-3 h-3 rounded-full bg-[var(--color-amber)]"
          />
          aktualny wybór
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block w-2.5 h-2.5 rounded-full bg-[var(--color-ink-3)]"
          />
          pozostałe — kliknij aby wybrać
        </span>
      </div>
    </div>
  );
};

export type { MetricId };
