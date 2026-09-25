import type { Offer } from "@/lib/match-types";
import type { Metric } from "@/lib/scatter-metrics";
import type { SortId } from "@/lib/sort-metrics";

/**
 * How many offers each leg of the scatter's default set contributes.
 * Three legs — best by X, best by Y, best value on the X/Y ratio — plus
 * two pinned dots, so the chart tops out at 11 points before the user
 * widens it through the company filter.
 */
export const TOP_N = 3;

/**
 * A ratio leg only means something when one axis is a cost and the other a
 * benefit: "most protein per złoty" is a value judgement, "most protein per
 * błonnik" is not. Two same-direction axes therefore produce no ratio leg —
 * the chart falls back to the two top-N legs rather than inventing a number.
 */
export interface RatioLeg {
  /** Bigger is always better. */
  readonly accessor: (o: Offer) => number;
  readonly eligible: (o: Offer) => boolean;
  /** Polish label, e.g. "białko/cena". */
  readonly label: string;
  /** Pool branch that fetches this ratio's day-wide leaders, if one exists. */
  readonly poolSortId?: SortId;
}

/**
 * Value ratios that exist as a real `SortId`, keyed `benefit::cost`. Every
 * one of dietly's ratio sorts divides by price, so any benefit/cost pair
 * whose cost isn't `price` computes in-pool only.
 */
const RATIO_SORT_IDS: Readonly<Record<string, SortId>> = {
  "fiber::price": "fiber-per-zl",
  "protein::price": "protein-per-zl",
  "review::price": "review-per-zl",
  "score::price": "score-per-zl",
};

const isEligible = (m: Metric, o: Offer): boolean => m.eligible?.(o) ?? true;

/** Ranks `offers` best-first for `metric`, dropping ineligible entries. */
export const topByMetric = (
  offers: readonly Offer[],
  metric: Metric,
  n: number
): readonly Offer[] =>
  offers
    .filter((o) => isEligible(metric, o))
    .toSorted((a, b) => {
      const av = metric.accessor(a);
      const bv = metric.accessor(b);
      return metric.higherIsBetter ? bv - av : av - bv;
    })
    .slice(0, n);

/**
 * Builds the benefit/cost ratio for the current axes, or `null` when both
 * axes pull the same way.
 */
export const ratioLeg = (x: Metric, y: Metric): RatioLeg | null => {
  const xIsCost = !x.higherIsBetter;
  const yIsCost = !y.higherIsBetter;
  if (xIsCost === yIsCost) {
    return null;
  }
  const cost = xIsCost ? x : y;
  const benefit = xIsCost ? y : x;
  return {
    accessor: (o) => benefit.accessor(o) / cost.accessor(o),
    // A zero cost would make every ratio Infinity and swamp the leg, so the
    // metric's own eligibility guard is backed by an explicit `> 0`.
    eligible: (o) =>
      isEligible(cost, o) && isEligible(benefit, o) && cost.accessor(o) > 0,
    label: `${benefit.label}/${cost.label}`,
    poolSortId: RATIO_SORT_IDS[`${benefit.id}::${cost.id}`],
  };
};

/** Ranks `offers` by the ratio leg, best value first. */
export const topByRatio = (
  offers: readonly Offer[],
  leg: Readonly<RatioLeg>,
  n: number
): readonly Offer[] =>
  offers
    .filter((o) => leg.eligible(o))
    .toSorted((a, b) => leg.accessor(b) - leg.accessor(a))
    .slice(0, n);

export interface TopSelectionArgs {
  readonly offers: readonly Offer[];
  readonly xMetric: Metric;
  readonly yMetric: Metric;
  /** Cheapest offer of the day — pinned as a price anchor. */
  readonly cheapestId: string;
  /** The row's current pick — pinned so clicking a dot keeps a visible target. */
  readonly selectedId: string;
}

export interface TopSelection {
  /** Offers to plot by default, deduped, legs in priority order. */
  readonly offers: readonly Offer[];
  /** `null` when the axes share a direction and no ratio leg was computed. */
  readonly ratioLabel: string | null;
}

/**
 * The scatter's default point set: top-N by X, top-N by Y, top-N by the
 * X/Y value ratio, plus the cheapest and currently-selected offers.
 *
 * Legs are merged first-occurrence-wins in that order — the same convention
 * the pool fetch uses — so an offer that leads on two legs is plotted once.
 * Selection is per **offer**, never per company: a catering that owns three
 * of the top slots contributes three dots, not its whole catalogue.
 */
export const selectTopOffers = ({
  cheapestId,
  offers,
  selectedId,
  xMetric,
  yMetric,
}: Readonly<TopSelectionArgs>): TopSelection => {
  const seen = new Set<string>();
  const out: Offer[] = [];
  const push = (o: Offer) => {
    if (!seen.has(o.offer_id)) {
      seen.add(o.offer_id);
      out.push(o);
    }
  };
  for (const o of topByMetric(offers, xMetric, TOP_N)) {
    push(o);
  }
  for (const o of topByMetric(offers, yMetric, TOP_N)) {
    push(o);
  }
  const leg = ratioLeg(xMetric, yMetric);
  if (leg !== null) {
    for (const o of topByRatio(offers, leg, TOP_N)) {
      push(o);
    }
  }
  for (const o of offers) {
    if (o.offer_id === cheapestId || o.offer_id === selectedId) {
      push(o);
    }
  }
  return { offers: out, ratioLabel: leg?.label ?? null };
};
