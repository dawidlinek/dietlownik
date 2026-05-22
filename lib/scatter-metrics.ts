import { formatPriceNumber } from "@/lib/format";
import type { Offer } from "@/lib/match-types";

export type MetricId =
  | "price"
  | "score"
  | "score_default"
  | "kcal"
  | "protein"
  | "fat"
  | "carbs"
  | "fiber"
  | "sugar"
  | "review";

export interface Metric {
  readonly id: MetricId;
  readonly label: string;
  readonly unit: string;
  readonly accessor: (o: Offer) => number;
  readonly format: (v: number) => string;
  /** True for metrics where bigger is "better" (positive = green). */
  readonly higherIsBetter: boolean;
}

const formatScore = (v: number): string => {
  if (Math.abs(v) < 0.05) {
    return "0,0";
  }
  const sign = v > 0 ? "+" : "−";
  return `${sign}${Math.abs(v).toFixed(1).replace(".", ",")}`;
};

const formatInt = (v: number): string =>
  new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 0 }).format(v);

export const METRICS: readonly Metric[] = [
  {
    accessor: (o) => o.price_per_day,
    format: (v) => formatPriceNumber(v),
    higherIsBetter: false,
    id: "price",
    label: "cena",
    unit: "zł",
  },
  {
    accessor: (o) => o.score_best,
    format: formatScore,
    higherIsBetter: true,
    id: "score",
    label: "score",
    unit: "",
  },
  {
    accessor: (o) => o.score_default,
    format: formatScore,
    higherIsBetter: true,
    id: "score_default",
    label: "score (default)",
    unit: "",
  },
  {
    accessor: (o) => o.total_kcal,
    format: formatInt,
    higherIsBetter: false,
    id: "kcal",
    label: "kcal",
    unit: "kcal",
  },
  {
    accessor: (o) => o.total_protein_g,
    format: formatInt,
    higherIsBetter: true,
    id: "protein",
    label: "białko",
    unit: "g",
  },
  {
    accessor: (o) => o.total_fat_g,
    format: formatInt,
    higherIsBetter: false,
    id: "fat",
    label: "tłuszcz",
    unit: "g",
  },
  {
    accessor: (o) => o.total_carbs_g,
    format: formatInt,
    higherIsBetter: false,
    id: "carbs",
    label: "węgle",
    unit: "g",
  },
  {
    accessor: (o) => o.total_fiber_g,
    format: formatInt,
    higherIsBetter: true,
    id: "fiber",
    label: "błonnik",
    unit: "g",
  },
  {
    accessor: (o) => o.total_sugar_g,
    format: formatInt,
    higherIsBetter: false,
    id: "sugar",
    label: "cukry",
    unit: "g",
  },
  {
    accessor: (o) => o.review_score ?? 0,
    format: (v) =>
      new Intl.NumberFormat("pl-PL", {
        maximumFractionDigits: 2,
        minimumFractionDigits: 1,
      }).format(v),
    higherIsBetter: true,
    id: "review",
    label: "ocena",
    unit: "★",
  },
];

export const getMetric = (id: MetricId): Metric => {
  const found = METRICS.find((m) => m.id === id);
  if (!found) {
    throw new Error(`Unknown metric id: ${id}`);
  }
  return found;
};
