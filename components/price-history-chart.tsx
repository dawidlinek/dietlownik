"use client";

import * as React from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceDot,
  XAxis,
} from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { formatPriceNumber } from "@/lib/format";

const chartConfig = {
  price: {
    label: "Cena/dzień",
    color: "var(--chart-1)",
  },
} satisfies ChartConfig;

export interface HistoryPoint {
  bucket: string; // ISO yyyy-mm-dd
  price: number;
  promo_codes: string[] | null;
}

export function PriceHistoryChart({ history }: { history: HistoryPoint[] }) {
  const data = history.map((h) => ({
    date: h.bucket,
    price: Number(h.price),
  }));

  const promos = history
    .filter((h) => Array.isArray(h.promo_codes) && h.promo_codes.length > 0)
    .map((h) => ({
      date: h.bucket,
      code: (h.promo_codes ?? []).join(","),
      price: Number(h.price),
    }));

  if (data.length === 0) {
    return (
      <p className="text-[13px] text-[var(--color-ink-3)]">
        Brak danych historycznych.
      </p>
    );
  }

  return (
    <div>
      <ChartContainer
        config={chartConfig}
        className="aspect-auto h-[200px] w-full"
      >
        <AreaChart data={data} margin={{ left: 8, right: 8, top: 8, bottom: 0 }}>
          <defs>
            <linearGradient id="fillPrice" x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="5%"
                stopColor="var(--color-price)"
                stopOpacity={0.35}
              />
              <stop
                offset="95%"
                stopColor="var(--color-price)"
                stopOpacity={0.02}
              />
            </linearGradient>
          </defs>
          <CartesianGrid
            vertical={false}
            strokeDasharray="2 4"
            stroke="var(--color-bone)"
          />
          <XAxis
            dataKey="date"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={32}
            tickFormatter={(value) =>
              new Date(value).toLocaleDateString("pl-PL", {
                month: "short",
                day: "numeric",
              })
            }
          />
          <ChartTooltip
            cursor={{ stroke: "var(--color-bone)", strokeWidth: 1 }}
            content={
              <ChartTooltipContent
                indicator="line"
                labelFormatter={(value) =>
                  new Date(value as string).toLocaleDateString("pl-PL", {
                    month: "long",
                    day: "numeric",
                  })
                }
                formatter={(value) =>
                  `${formatPriceNumber(value as number)} zł`
                }
              />
            }
          />
          <Area
            dataKey="price"
            type="monotone"
            fill="url(#fillPrice)"
            stroke="var(--color-price)"
            strokeWidth={1.5}
            dot={data.length === 1 ? { r: 3, fill: "var(--color-price)" } : false}
            activeDot={{ r: 4, fill: "var(--color-price)" }}
          />
          {promos.map((p) => (
            <ReferenceDot
              key={p.date + p.code}
              x={p.date}
              y={p.price}
              r={4}
              fill="var(--color-amber)"
              stroke="var(--color-cream)"
              strokeWidth={2}
            />
          ))}
        </AreaChart>
      </ChartContainer>
      {data.length === 1 && (
        <p className="mt-2 text-[12px] text-[var(--color-ink-3)]">
          Tylko 1 dzień danych.
        </p>
      )}
    </div>
  );
}
