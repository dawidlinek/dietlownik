import { formatPriceNumber } from "@/lib/format";
import type { Offer } from "@/lib/match-types";

export type SortId =
  | "price-asc"
  | "score-desc"
  | "review-desc"
  | "protein-per-zl"
  | "fiber-per-zl"
  | "score-per-zl"
  | "kcal-per-zl"
  | "review-per-zl"
  | "protein-desc"
  | "fiber-desc"
  | "fat-asc"
  | "carbs-asc";

export interface SortOption {
  readonly id: SortId;
  /** Long label for menus, Polish. */
  readonly label: string;
  /** Tight label shown as a chip / column header (lowercase, no arrow). */
  readonly short: string;
  /** Group bucket for the dropdown — basics, value-for-money ratios, or raw macros. */
  readonly group: "basic" | "ratio" | "macro";
  /** Raw value used for ranking — direction below decides asc/desc. */
  readonly accessor: (o: Offer) => number;
  /** asc = smaller wins, desc = bigger wins. */
  readonly direction: "asc" | "desc";
  /** Formatted display of the ranking value (for the side column). */
  readonly format: (o: Offer) => string;
  /** Optional explanation shown in the dropdown. */
  readonly hint?: string;
  /**
   * Optional eligibility filter applied before ranking. Used to drop offers
   * whose macro value is missing (reported as 0) when sorting in a direction
   * where that missing-as-0 would dishonestly win — e.g. fat-asc / carbs-asc.
   * If the filter wipes every offer for a day, `rankOffers` falls back to the
   * unfiltered list so the day doesn't silently vanish.
   */
  readonly filter?: (o: Offer) => boolean;
}

const formatScore = (v: number): string => {
  if (Math.abs(v) < 0.05) {
    return "0,0";
  }
  const sign = v > 0 ? "+" : "−";
  return `${sign}${Math.abs(v).toFixed(1).replace(".", ",")}`;
};

const formatFixed = (v: number, digits: number): string =>
  new Intl.NumberFormat("pl-PL", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(v);

const safeDiv = (num: number, denom: number): number => {
  if (denom <= 0) {
    return 0;
  }
  return num / denom;
};

export const SORT_OPTIONS: readonly SortOption[] = [
  {
    accessor: (o) => o.price_per_day,
    direction: "asc",
    format: (o) => `${formatPriceNumber(o.price_per_day)} zł`,
    group: "basic",
    hint: "od najtańszej",
    id: "price-asc",
    label: "cena (najtańsze)",
    short: "cena",
  },
  {
    accessor: (o) => o.score_best,
    direction: "desc",
    format: (o) => formatScore(o.score_best),
    group: "basic",
    hint: "najlepsze dopasowanie do preferencji",
    id: "score-desc",
    label: "score (najlepsze)",
    short: "score",
  },
  {
    accessor: (o) => o.review_score ?? 0,
    direction: "desc",
    format: (o) =>
      o.review_score === null ? "—" : `${formatFixed(o.review_score, 2)} ★`,
    group: "basic",
    hint: "średnia ocena posiłków (fallback: ocena cateringu)",
    id: "review-desc",
    label: "ocena (najwyższa)",
    short: "ocena",
  },
  {
    accessor: (o) => safeDiv(o.total_protein_g, o.price_per_day),
    direction: "desc",
    format: (o) =>
      `${formatFixed(safeDiv(o.total_protein_g, o.price_per_day), 2)} g/zł`,
    group: "ratio",
    hint: "gramów białka na każdą wydaną złotówkę",
    id: "protein-per-zl",
    label: "białko za złotówkę",
    short: "białko/zł",
  },
  {
    accessor: (o) => safeDiv(o.total_fiber_g, o.price_per_day),
    direction: "desc",
    format: (o) =>
      `${formatFixed(safeDiv(o.total_fiber_g, o.price_per_day), 2)} g/zł`,
    group: "ratio",
    hint: "gramów błonnika na każdą wydaną złotówkę",
    id: "fiber-per-zl",
    label: "błonnik za złotówkę",
    short: "błonnik/zł",
  },
  {
    accessor: (o) => safeDiv(o.score_best, o.price_per_day) * 100,
    direction: "desc",
    format: (o) => formatFixed(safeDiv(o.score_best, o.price_per_day) * 100, 2),
    group: "ratio",
    hint: "wynik dopasowania w stosunku do ceny (×100)",
    id: "score-per-zl",
    label: "score za złotówkę",
    short: "score/zł",
  },
  {
    accessor: (o) => safeDiv(o.total_kcal, o.price_per_day),
    direction: "desc",
    format: (o) =>
      `${formatFixed(safeDiv(o.total_kcal, o.price_per_day), 1)} kcal/zł`,
    group: "ratio",
    hint: "kalorii na każdą wydaną złotówkę",
    id: "kcal-per-zl",
    label: "kcal za złotówkę",
    short: "kcal/zł",
  },
  {
    // ×100 keeps the displayed number in the same readable range as the other
    // ratios — raw avg-rating-over-price sits around 0.06 (≈4.5 ★ / 70 zł)
    // which truncates to "0,06" and reads as noise.
    accessor: (o) =>
      o.review_score === null
        ? 0
        : safeDiv(o.review_score, o.price_per_day) * 100,
    direction: "desc",
    format: (o) =>
      o.review_score === null
        ? "—"
        : formatFixed(safeDiv(o.review_score, o.price_per_day) * 100, 2),
    group: "ratio",
    hint: "średnia ocena posiłków (fallback: ocena cateringu) podzielona przez cenę (×100)",
    id: "review-per-zl",
    label: "ocena za złotówkę",
    short: "ocena/zł",
  },
  {
    accessor: (o) => o.total_protein_g,
    direction: "desc",
    format: (o) => `${formatFixed(o.total_protein_g, 0)} g`,
    group: "macro",
    hint: "najwięcej białka na dzień",
    id: "protein-desc",
    label: "białko (najwięcej)",
    short: "białko",
  },
  {
    accessor: (o) => o.total_fiber_g,
    direction: "desc",
    format: (o) => `${formatFixed(o.total_fiber_g, 0)} g`,
    group: "macro",
    hint: "najwięcej błonnika na dzień",
    id: "fiber-desc",
    label: "błonnik (najwięcej)",
    short: "błonnik",
  },
  {
    accessor: (o) => o.total_fat_g,
    direction: "asc",
    // Caterings that don't report macros surface as 0 g, which would otherwise
    // top an asc sort. Drop them so "least fat" reflects real diets only.
    filter: (o) => o.total_fat_g > 0,
    format: (o) => `${formatFixed(o.total_fat_g, 0)} g`,
    group: "macro",
    hint: "najmniej tłuszczu na dzień (pomija cateringi bez deklarowanych makro)",
    id: "fat-asc",
    label: "tłuszcz (najmniej)",
    short: "tłuszcz",
  },
  {
    accessor: (o) => o.total_carbs_g,
    direction: "asc",
    filter: (o) => o.total_carbs_g > 0,
    format: (o) => `${formatFixed(o.total_carbs_g, 0)} g`,
    group: "macro",
    hint: "najmniej węglowodanów na dzień (pomija cateringi bez deklarowanych makro)",
    id: "carbs-asc",
    label: "węglowodany (najmniej)",
    short: "węgle",
  },
];

export const getSortOption = (id: SortId): SortOption => {
  const found = SORT_OPTIONS.find((s) => s.id === id);
  if (!found) {
    throw new Error(`Unknown sort id: ${id}`);
  }
  return found;
};

export const rankOffers = <T extends Offer>(
  offers: readonly T[],
  sortId: SortId
): readonly T[] => {
  const opt = getSortOption(sortId);
  const sign = opt.direction === "asc" ? 1 : -1;
  const eligible =
    opt.filter === undefined ? offers : offers.filter(opt.filter);
  // If the eligibility filter drops every offer (e.g. no catering reports fat
  // for the day), fall back to the raw set so the day still renders something.
  const pool = eligible.length > 0 ? eligible : offers;
  return [...pool].toSorted(
    (a, b) => sign * (opt.accessor(a) - opt.accessor(b))
  );
};

type ScatterYMetric =
  | "score"
  | "kcal"
  | "protein"
  | "fat"
  | "carbs"
  | "fiber"
  | "review";

const SORT_TO_Y: Readonly<Record<SortId, ScatterYMetric>> = {
  "carbs-asc": "carbs",
  "fat-asc": "fat",
  "fiber-desc": "fiber",
  "fiber-per-zl": "fiber",
  "kcal-per-zl": "kcal",
  "price-asc": "score",
  "protein-desc": "protein",
  "protein-per-zl": "protein",
  "review-desc": "review",
  "review-per-zl": "review",
  "score-desc": "score",
  "score-per-zl": "score",
};

/**
 * Maps a sort to a scatter Y-axis metric, so picking a sort chip drives the
 * scatter axes (X is always price; Y is what you sorted by).
 */
export const sortToYMetricId = (id: SortId): ScatterYMetric => SORT_TO_Y[id];
