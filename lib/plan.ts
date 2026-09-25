import type { HandoffGroup } from "@/components/dietly-handoff";
import type { Offer } from "@/lib/match-types";

/** One day of the plan: the offer the list currently resolves to for it
 *  (rank-1 under the active sort, or the user's scatter override). */
export interface ResolvedSelection {
  readonly date: string;
  readonly weekday: string;
  readonly offer: Offer;
}

export interface PlanCode {
  readonly code: string;
  /** How many days of the plan carry this code. */
  readonly days: number;
}

export interface PlanMath {
  readonly days: number;
  readonly caterings: readonly string[];
  /** Sum of per-day list prices — `price_per_day_before_promo` where a code
   *  applied, otherwise the price itself. */
  readonly listTotal: number;
  readonly total: number;
  readonly savings: number;
  readonly codes: readonly PlanCode[];
}

export const planMath = (resolved: readonly ResolvedSelection[]): PlanMath => {
  let listTotal = 0;
  let total = 0;
  const caterings: string[] = [];
  const codeDays = new Map<string, number>();
  for (const { offer } of resolved) {
    total += offer.price_per_day;
    listTotal += offer.price_per_day_before_promo ?? offer.price_per_day;
    if (!caterings.includes(offer.company_name)) {
      caterings.push(offer.company_name);
    }
    for (const p of offer.promos) {
      codeDays.set(p.code, (codeDays.get(p.code) ?? 0) + 1);
    }
  }
  const codes: PlanCode[] = [];
  for (const [code, days] of codeDays) {
    codes.push({ code, days });
  }
  return {
    caterings,
    codes,
    days: resolved.length,
    listTotal,
    savings: listTotal - total,
    total,
  };
};

/** Group the per-day picks by catering — dietly's basket holds one catering
 *  at a time, so that is the unit the handoff sends. */
export const toHandoffGroups = (
  resolved: readonly ResolvedSelection[]
): HandoffGroup[] => {
  const groups = new Map<string, HandoffGroup>();
  for (const { date, offer, weekday } of resolved) {
    const prev = groups.get(offer.company_id);
    const day = {
      date,
      offer_id: offer.offer_id,
      picks: offer.picks.flatMap((p) =>
        p.meal_id === undefined
          ? []
          : [{ meal_id: p.meal_id, slot_name: p.slot_name }]
      ),
      price_per_day: offer.price_per_day,
      weekday,
    };
    const codes = offer.promos.map((pr) => pr.code);
    groups.set(offer.company_id, {
      company_id: offer.company_id,
      company_name: offer.company_name,
      days: [...(prev?.days ?? []), day],
      promo_codes: [...new Set([...(prev?.promo_codes ?? []), ...codes])],
    });
  }
  return [...groups.values()];
};
