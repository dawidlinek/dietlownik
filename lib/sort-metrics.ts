import { formatPriceNumber } from "@/lib/format";
import type { MockOffer } from "@/lib/mock-match-data";

export type SortId =
  | "price-asc"
  | "score-desc"
  | "protein-per-zl"
  | "fiber-per-zl"
  | "score-per-zl"
  | "kcal-per-zl";

export interface SortOption {
  readonly id: SortId;
  /** Long label for menus, Polish. */
  readonly label: string;
  /** Tight label shown as a chip / column header (lowercase, no arrow). */
  readonly short: string;
  /** Group bucket for the dropdown — basics vs. value-for-money ratios. */
  readonly group: "basic" | "ratio";
  /** Raw value used for ranking — direction below decides asc/desc. */
  readonly accessor: (o: MockOffer) => number;
  /** asc = smaller wins, desc = bigger wins. */
  readonly direction: "asc" | "desc";
  /** Formatted display of the ranking value (for the side column). */
  readonly format: (o: MockOffer) => string;
  /** Optional explanation shown in the dropdown. */
  readonly hint?: string;
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
];

export const getSortOption = (id: SortId): SortOption => {
  const found = SORT_OPTIONS.find((s) => s.id === id);
  if (!found) {
    throw new Error(`Unknown sort id: ${id}`);
  }
  return found;
};

export const rankOffers = <T extends MockOffer>(
  offers: readonly T[],
  sortId: SortId
): readonly T[] => {
  const opt = getSortOption(sortId);
  const sign = opt.direction === "asc" ? 1 : -1;
  return [...offers].toSorted(
    (a, b) => sign * (opt.accessor(a) - opt.accessor(b))
  );
};
