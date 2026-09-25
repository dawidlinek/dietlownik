import { formatPriceNumber } from "@/lib/format";
import type { Offer } from "@/lib/match-types";
import type { SortId } from "@/lib/sort-metrics";

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
  /**
   * Optional eligibility filter, applied before a "top N by this metric"
   * pick. Caterings that don't report macros surface every macro as 0,
   * which would sweep the whole top-N of any lower-is-better metric — a
   * diet with no declared fat is not the leanest diet. Mirrors the same
   * guard on the asc sorts in `lib/sort-metrics.ts`.
   *
   * Only relevant for `higherIsBetter: false` metrics; a missing-as-0 on a
   * higher-is-better metric sinks to the bottom on its own.
   */
  readonly eligible?: (o: Offer) => boolean;
  /**
   * Sort branch that fetches this metric's genuine day-wide leaders. The
   * scatter's candidate pool is assembled from sort branches, so without
   * one a "top 3 by X" is only top-3-of-whatever-the-pool-happens-to-hold.
   * `undefined` for metrics with no matching `SortId` (score_default,
   * kcal, sugar) — those stay top-of-pool.
   */
  readonly poolSortId?: SortId;
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
    poolSortId: "price-asc",
    unit: "zł",
  },
  {
    accessor: (o) => o.score_best,
    format: formatScore,
    higherIsBetter: true,
    id: "score",
    label: "score",
    poolSortId: "score-desc",
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
    eligible: (o) => o.total_kcal > 0,
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
    poolSortId: "protein-desc",
    unit: "g",
  },
  {
    accessor: (o) => o.total_fat_g,
    eligible: (o) => o.total_fat_g > 0,
    format: formatInt,
    higherIsBetter: false,
    id: "fat",
    label: "tłuszcz",
    poolSortId: "fat-asc",
    unit: "g",
  },
  {
    accessor: (o) => o.total_carbs_g,
    eligible: (o) => o.total_carbs_g > 0,
    format: formatInt,
    higherIsBetter: false,
    id: "carbs",
    label: "węgle",
    poolSortId: "carbs-asc",
    unit: "g",
  },
  {
    accessor: (o) => o.total_fiber_g,
    format: formatInt,
    higherIsBetter: true,
    id: "fiber",
    label: "błonnik",
    poolSortId: "fiber-desc",
    unit: "g",
  },
  {
    accessor: (o) => o.total_sugar_g,
    eligible: (o) => o.total_sugar_g > 0,
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
    poolSortId: "review-desc",
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
