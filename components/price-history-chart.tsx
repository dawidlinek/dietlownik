"use client";

import * as React from "react";
import { Area, AreaChart, CartesianGrid, ReferenceDot, XAxis } from "recharts";

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import type { ChartConfig } from "@/components/ui/chart";
import { formatPriceNumber } from "@/lib/format";

const chartConfig = {
  price: {
    color: "var(--chart-1)",
    label: "Cena/dzień",
  },
} satisfies ChartConfig;

export interface HistoryPoint {
  /** ISO yyyy-mm-dd */
  bucket: string;
  price: number;
  promo_codes: string[] | null;
}

export const PriceHistoryChart = ({ history }: { history: HistoryPoint[] }) => {
  const data = history.map((h) => ({
    date: h.bucket,
    price: h.price,
  }));

  const promos = history
    .filter((h) => Array.isArray(h.promo_codes) && h.promo_codes.length > 0)
    .map((h) => ({
      code: (h.promo_codes ?? []).join(","),
      date: h.bucket,
      price: h.price,
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
        <AreaChart
          data={data}
          margin={{ bottom: 0, left: 8, right: 8, top: 8 }}
        >
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
            axisLine={false}
            dataKey="date"
            minTickGap={32}
            tickFormatter={(value: string) =>
              new Date(value).toLocaleDateString("pl-PL", {
                day: "numeric",
                month: "short",
              })
            }
            tickLine={false}
            tickMargin={8}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                formatter={(value) =>
                  `${formatPriceNumber(typeof value === "number" ? value : Number(value))} zł`
                }
                indicator="line"
                labelFormatter={(value) =>
                  new Date(
                    typeof value === "string" ? value : String(value)
                  ).toLocaleDateString("pl-PL", {
                    day: "numeric",
                    month: "long",
                  })
                }
              />
            }
            cursor={{ stroke: "var(--color-bone)", strokeWidth: 1 }}
          />
          <Area
            dataKey="price"
            type="monotone"
            fill="url(#fillPrice)"
            stroke="var(--color-price)"
            strokeWidth={1.5}
            dot={
              data.length === 1 ? { fill: "var(--color-price)", r: 3 } : false
            }
            activeDot={{ fill: "var(--color-price)", r: 4 }}
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
};
