// View types shared by the /match and / (live MatchExperience2) pages.
// Same shape across mock fixtures and live data — components consume these
// regardless of source, and `toViewOffer` below adapts the DB ranking result.

import type { RankedDayOffer, WeekViewDay } from "./queries";

export interface Hit {
  readonly source:
    | "allergen"
    | "category"
    | "macro"
    | "ingredient"
    | "embedding";
  readonly keyword: string;
  readonly channel: "prefer" | "avoid";
  /** Signed; positive for prefer hits, negative for avoid. */
  readonly contribution: number;
  readonly reason: string;
}

/** Per-meal macros (one serving). */
export interface MealMacros {
  readonly kcal: number;
  readonly protein_g: number;
  readonly fat_g: number;
  readonly carbs_g: number;
  readonly fiber_g: number;
  readonly sugar_g: number;
}

/** A single meal option in a slot (sans slot context). */
export interface MealOption extends MealMacros {
  /** `meals.id` — lets the dietly basket handoff resolve the slot id dietly
   *  wants. Absent on the /match mock fixtures. */
  readonly meal_id?: number;
  readonly meal_name: string;
  /** Signed; sum of this option's hits.contribution. */
  readonly meal_score: number;
  readonly is_default: boolean;
  readonly hits: readonly Hit[];
  /** Comma-separated ingredient list, Polish, as the dietly API returns it. */
  readonly ingredients_raw: string;
  /** Normalized allergen names from `dietlyAllergenName`. */
  readonly allergens: readonly string[];
  /** 0–5 rating from `meals.reviews_score`; null when not collected. */
  readonly review_score: number | null;
}

export interface Pick extends MealOption {
  readonly slot_name: string;
  /** Other meals available in this slot — only set on menu-config offers. */
  readonly alternates?: readonly MealOption[];
}

/** Active promo code applied to an offer. */
export interface Promo {
  readonly code: string;
  /** 0–100. Discount already baked into `price_per_day`. */
  readonly discount_percent: number;
  /** ISO date when the campaign expires (omit for indefinite). */
  readonly ends_at?: string;
}

export interface Offer {
  readonly offer_id: string;
  /** URL-stable catering slug (e.g. `robinfood`), used to link to dietly.pl. */
  readonly company_id: string;
  readonly company_name: string;
  /** Absolute URL to the catering's logo, or null when unknown. */
  readonly logo_url: string | null;
  readonly diet_name: string;
  readonly tier_name: string | null;
  /** Diet's target kcal tier. */
  readonly calories: number;
  readonly is_menu_configuration: boolean;
  /** Per-day price after all active promos. */
  readonly price_per_day: number;
  /** Per-day price before promo codes (null = no promo applied). */
  readonly price_per_day_before_promo: number | null;
  readonly promos: readonly Promo[];
  readonly score_default: number;
  readonly score_best: number;
  readonly picks: readonly Pick[];
  /** Aggregated daily macros across the picks. */
  readonly total_kcal: number;
  readonly total_protein_g: number;
  readonly total_fat_g: number;
  readonly total_carbs_g: number;
  readonly total_fiber_g: number;
  readonly total_sugar_g: number;
  /** 0–5 rating: avg of picked-meal ratings, falling back to the catering
   *  average. Null when neither source has data. */
  readonly review_score: number | null;
}

export interface Day {
  /** ISO yyyy-mm-dd. */
  readonly date: string;
  readonly weekday_short_pl: string;
  /** May be null when no menus were captured for this date. */
  readonly cheapest: Offer | null;
  /** May === cheapest (collapsed row) or null when no menus captured. */
  readonly best_fit: Offer | null;
  readonly total_considered: number;
  /** All offers for that day — for the scatter view. Includes cheapest + best_fit. */
  readonly all_offers: readonly Offer[];
}

// ── Macro aggregation ───────────────────────────────────────────────────────

/** Sum a list of picks into total daily macros. */
export const aggregateMacros = (
  meals: readonly Readonly<MealMacros>[]
): MealMacros => {
  let kcal = 0;
  let protein_g = 0;
  let fat_g = 0;
  let carbs_g = 0;
  let fiber_g = 0;
  let sugar_g = 0;
  for (const m of meals) {
    kcal += m.kcal;
    protein_g += m.protein_g;
    fat_g += m.fat_g;
    carbs_g += m.carbs_g;
    fiber_g += m.fiber_g;
    sugar_g += m.sugar_g;
  }
  return { carbs_g, fat_g, fiber_g, kcal, protein_g, sugar_g };
};

// ── Polish weekday short names ──────────────────────────────────────────────

const WEEKDAY_PL: readonly string[] = [
  "nd",
  "pon",
  "wt",
  "śr",
  "czw",
  "pt",
  "sob",
];

export const weekdayShortPl = (isoDate: string): string => {
  const d = new Date(`${isoDate}T00:00:00`);
  return WEEKDAY_PL[d.getDay()] ?? "";
};

// ── Mapper: RankedDayOffer → Offer ──────────────────────────────────────────

const numOr = (
  raw: string | number | null | undefined,
  fallback: number
): number => {
  if (raw === null || raw === undefined) {
    return fallback;
  }
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

const toMealOption = (
  meal: RankedDayOffer["picks"][number]["meal"],
  isDefault: boolean
): MealOption => ({
  allergens: meal.allergens ?? [],
  carbs_g: numOr(meal.carbs_g ?? null, 0),
  fat_g: numOr(meal.fat_g ?? null, 0),
  fiber_g: numOr(meal.fiber_g ?? null, 0),
  hits: meal.hits ?? [],
  ingredients_raw: meal.ingredients_raw ?? "",
  is_default: isDefault,
  kcal: numOr(meal.kcal ?? null, 0),
  meal_id: meal.meal_id,
  meal_name: meal.meal_name,
  meal_score: numOr(meal.score, 0),
  protein_g: numOr(meal.protein_g ?? null, 0),
  review_score: meal.review_score ?? null,
  sugar_g: numOr(meal.sugar_g ?? null, 0),
});

export const toViewOffer = (r: Readonly<RankedDayOffer>): Offer => {
  const picks: Pick[] = r.picks.map((p) => {
    const { meal } = p;
    const base = toMealOption(meal, p.is_default);
    if (r.is_menu_configuration && p.alternates && p.alternates.length > 0) {
      const altOptions = p.alternates.map((alt) =>
        toMealOption(alt, alt.is_default ?? false)
      );
      return { ...base, alternates: altOptions, slot_name: p.slot_name };
    }
    return { ...base, slot_name: p.slot_name };
  });

  const totals = aggregateMacros(picks);

  // `r.price_per_day` is already net of all discounts dietly's API applied
  // (computed in the `priced` CTE as total_cost / order_days). Take it at
  // face value — applying promo math here too would double-count.
  const priceFinal = Number(numOr(r.price_per_day, 0).toFixed(2));
  const priceBeforeRaw = r.price_per_day_before_promo;
  const priceBefore =
    priceBeforeRaw === null || priceBeforeRaw === undefined
      ? null
      : numOr(priceBeforeRaw, priceFinal);
  const promos = r.promos ?? [];

  return {
    calories: numOr(r.calories, 0),
    company_id: r.company.id,
    company_name: r.company.name ?? r.company.id,
    diet_name: r.diet.name ?? "",
    is_menu_configuration: r.is_menu_configuration,
    logo_url: r.company.logo_url ?? null,
    offer_id: r.offer_id,
    picks,
    price_per_day: priceFinal,
    price_per_day_before_promo: priceBefore,
    promos,
    review_score: r.review_score ?? null,
    score_best: numOr(r.verdict.score_best, 0),
    score_default: numOr(r.verdict.score_default, 0),
    tier_name: r.tier?.name ?? null,
    total_carbs_g: totals.carbs_g,
    total_fat_g: totals.fat_g,
    total_fiber_g: totals.fiber_g,
    total_kcal: totals.kcal,
    total_protein_g: totals.protein_g,
    total_sugar_g: totals.sugar_g,
  };
};

// ── Mapper: WeekViewDay → Day ───────────────────────────────────────────────

const pickCheapest = (offers: readonly Offer[]): Offer | null => {
  let best: Offer | null = null;
  for (const o of offers) {
    if (best === null || o.price_per_day < best.price_per_day) {
      best = o;
    }
  }
  return best;
};

const pickBestFit = (offers: readonly Offer[]): Offer | null => {
  let best: Offer | null = null;
  for (const o of offers) {
    if (best === null || o.score_best > best.score_best) {
      best = o;
    }
  }
  return best;
};

export const toViewDay = (w: Readonly<WeekViewDay>): Day => {
  const all_offers: Offer[] = w.all_offers.map((r) => toViewOffer(r));
  return {
    all_offers,
    best_fit: pickBestFit(all_offers),
    cheapest: pickCheapest(all_offers),
    date: w.date,
    total_considered: w.total_considered,
    weekday_short_pl: weekdayShortPl(w.date),
  };
};
