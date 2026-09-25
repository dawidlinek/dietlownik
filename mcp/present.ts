// Shapes the ranking engine's `RankedDayOffer` into what an agent can read in
// one pass: the same numbers the dashboard shows (list → promo → final price,
// day totals, per-slot meals with the reasons they scored), without the
// payload bloat. `lib/queries.ts` stays the single source of every number.

import { z } from "zod";

import { weekdayShortPl } from "@/lib/match-types";
import type { RoutedIntents } from "@/lib/preference-router";
import type { DayPick, PreferenceHit, RankedDayOffer } from "@/lib/queries";
import type { SortId } from "@/lib/sort-metrics";

// ── Sorts ─────────────────────────────────────────────────────────────────

/** The dashboard's sort menu, in the words it uses. */
export const SORTS: Readonly<Record<SortId, string>> = {
  "carbs-asc": "najmniej węglowodanów",
  "fat-asc": "najmniej tłuszczu",
  "fiber-desc": "najwięcej błonnika",
  "fiber-per-zl": "błonnik na złotówkę",
  "kcal-per-zl": "kcal na złotówkę",
  "price-asc": "najtańsze",
  "protein-desc": "najwięcej białka",
  "protein-per-zl": "białko na złotówkę",
  "review-desc": "najlepiej oceniane",
  "review-per-zl": "ocena na złotówkę",
  "score-desc": "najlepsze dopasowanie do lubię/unikam",
  "score-per-zl": "dopasowanie na złotówkę",
};

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SORTS is exhaustive over SortId (Record<SortId, …>), so its keys are exactly the SortId union
export const SORT_IDS = Object.keys(SORTS) as [SortId, ...SortId[]];

export const sortSchema = z
  .enum(SORT_IDS)
  .default("score-desc")
  .describe(
    `How each day's winner is chosen: ${SORT_IDS.map((id) => `${id} (${SORTS[id]})`).join(", ")}.`
  );

// ── Numbers ───────────────────────────────────────────────────────────────

export const round = (n: number, digits = 2): number => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

const num = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined) {
    return null;
  }
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

// ── Hits ──────────────────────────────────────────────────────────────────

/** "+kurczak · ingredient: kurczak (… sim=1.00)" — sign says which list. */
export const hitLine = (h: Readonly<PreferenceHit>): string =>
  `${h.contribution >= 0 ? "+" : "−"}${h.keyword} · ${h.reason}`;

// ── Cards ─────────────────────────────────────────────────────────────────

const macrosSchema = z.object({
  carbs_g: z.number(),
  fat_g: z.number(),
  fiber_g: z.number(),
  kcal: z.number(),
  protein_g: z.number(),
  sugar_g: z.number(),
});

export const mealSchema = z.object({
  allergens: z.array(z.string()).optional(),
  hits: z.array(z.string()),
  ingredients: z.string().optional(),
  is_default: z.boolean(),
  kcal: z.number().nullable(),
  meal_id: z.number(),
  name: z.string(),
  protein_g: z.number().nullable(),
  rating: z.number().nullable().optional(),
  score: z.number(),
});

export const slotSchema = z.object({
  chosen: mealSchema,
  other_options: z
    .array(mealSchema)
    .optional()
    .describe(
      "Menu-choice diets only: the slot's other dishes, best-scoring first. Swap one in by its meal_id in the selection's picks."
    ),
  slot: z.string(),
});

export const priceSchema = z.object({
  list: z.number().nullable().describe("Per-day price before promo codes."),
  per_day: z
    .number()
    .describe(
      "Per-day price after the promo code below — the number rankings and totals use."
    ),
  promo: z
    .object({
      code: z.string(),
      discount_percent: z.number(),
      ends_at: z.string().nullable(),
    })
    .nullable()
    .describe(
      "The code this price assumes. Quote/basket apply it; if dietly rejects it the list price applies."
    ),
});

export const cardSchema = z.object({
  catering: z.object({ id: z.string(), name: z.string() }),
  day_totals: macrosSchema.describe(
    "Sum of the chosen meals, scaled to this offer's kcal."
  ),
  diet: z.string(),
  is_configurable: z
    .boolean()
    .describe(
      "Menu-choice diet: you pick a dish per slot. `meals` already shows the best-scoring pick."
    ),
  kcal: z.number().nullable(),
  meals: z.array(slotSchema).optional(),
  offer_id: z
    .string()
    .describe("Opaque token — pass as-is, never parse or build one."),
  price: priceSchema,
  rating: z
    .number()
    .nullable()
    .describe("0–5: picked meals' average rating, else the catering's."),
  score: z.object({
    best: z.number(),
    default: z
      .number()
      .describe("Score of the catering's default dishes, before any swaps."),
    slots: z.number(),
  }),
  tier: z.string().nullable(),
});

export type Card = z.infer<typeof cardSchema>;
type Meal = z.infer<typeof mealSchema>;

export interface CardOptions {
  /** Per-slot meals. */
  readonly meals: boolean;
  /** Ingredients, allergens and every other option in each slot. */
  readonly full?: boolean;
}

const toMeal = (
  m: Readonly<DayPick["meal"]>,
  isDefault: boolean,
  full: boolean
): Meal => ({
  ...(full
    ? {
        allergens: [...m.allergens],
        ingredients: m.ingredients_raw ?? "",
      }
    : {}),
  hits: m.hits.map(hitLine),
  is_default: isDefault,
  kcal: num(m.kcal) === null ? null : round(num(m.kcal) ?? 0, 0),
  meal_id: m.meal_id,
  name: m.meal_name,
  protein_g: num(m.protein_g) === null ? null : round(num(m.protein_g) ?? 0, 1),
  ...(full ? { rating: m.review_score } : {}),
  score: round(m.score, 3),
});

export const toCard = (
  o: Readonly<RankedDayOffer>,
  opts: Readonly<CardOptions>
): Card => {
  const totals = {
    carbs_g: 0,
    fat_g: 0,
    fiber_g: 0,
    kcal: 0,
    protein_g: 0,
    sugar_g: 0,
  };
  for (const p of o.picks) {
    totals.kcal += num(p.meal.kcal) ?? 0;
    totals.protein_g += num(p.meal.protein_g) ?? 0;
    totals.fat_g += num(p.meal.fat_g) ?? 0;
    totals.carbs_g += num(p.meal.carbs_g) ?? 0;
    totals.fiber_g += num(p.meal.fiber_g) ?? 0;
    totals.sugar_g += num(p.meal.sugar_g) ?? 0;
  }
  const [promo] = o.promos;
  const full = opts.full === true;
  return {
    catering: { id: o.company.id, name: o.company.name ?? o.company.id },
    day_totals: {
      carbs_g: round(totals.carbs_g, 0),
      fat_g: round(totals.fat_g, 0),
      fiber_g: round(totals.fiber_g, 0),
      kcal: round(totals.kcal, 0),
      protein_g: round(totals.protein_g, 0),
      sugar_g: round(totals.sugar_g, 0),
    },
    diet: o.diet.name ?? "",
    is_configurable: o.is_menu_configuration,
    kcal: o.calories,
    ...(opts.meals
      ? {
          meals: o.picks.map((p) => ({
            chosen: toMeal(p.meal, p.is_default, full),
            ...(full && p.alternates !== null && p.alternates.length > 0
              ? {
                  other_options: p.alternates
                    .filter((a) => a.meal_id !== p.meal.meal_id)
                    .map((a) => toMeal(a, a.is_default, full)),
                }
              : {}),
            slot: p.slot_name,
          })),
        }
      : {}),
    offer_id: o.offer_id,
    price: {
      list:
        o.price_per_day_before_promo === null
          ? null
          : round(o.price_per_day_before_promo),
      per_day: round(o.price_per_day ?? 0),
      promo:
        promo === undefined
          ? null
          : {
              code: promo.code,
              discount_percent: promo.discount_percent,
              ends_at: promo.ends_at ?? null,
            },
    },
    rating: o.review_score === null ? null : round(o.review_score, 2),
    score: {
      best: round(o.verdict.score_best, 3),
      default: round(o.verdict.score_default, 3),
      slots: o.verdict.n_slots,
    },
    tier: o.tier?.name ?? null,
  };
};

// ── Selections (what quote / send_to_basket take) ──────────────────────────

export const selectionSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  offer_id: z.string().min(1),
  picks: z
    .array(z.object({ meal_id: z.number().int(), slot: z.string().min(1) }))
    .default([])
    .describe(
      "One dish per slot, for menu-choice diets. Fixed diets ignore it."
    ),
  promo_code: z.string().nullable().default(null),
});

export type Selection = z.infer<typeof selectionSchema>;

export const toSelection = (
  date: string,
  o: Readonly<RankedDayOffer>
): Selection => ({
  date,
  offer_id: o.offer_id,
  picks: o.is_menu_configuration
    ? o.picks.map((p) => ({ meal_id: p.meal.meal_id, slot: p.slot_name }))
    : [],
  promo_code: o.promos[0]?.code ?? null,
});

// ── Keyword report ─────────────────────────────────────────────────────────

export const keywordSchema = z.object({
  keyword: z.string(),
  list: z.enum(["prefer", "avoid"]).describe("The list it was given on."),
  matched_meals: z
    .number()
    .describe("Chosen meals across the returned days that it hit."),
  note: z.string().nullable(),
  understood_as: z.string(),
});

type KeywordReport = z.infer<typeof keywordSchema>;

const MACRO_WORDS: Readonly<Record<string, string>> = {
  carbs_g: "węglowodany",
  fat_g: "tłuszcz",
  fiber_g: "błonnik",
  kcal: "kcal",
  protein_g: "białko",
  salt_g: "sól",
  sugar_g: "cukier",
};

type List = "prefer" | "avoid";

interface Understood {
  readonly as: string;
  /** The list the router actually scored it on. */
  readonly routedTo: List;
}

/** Exact-channel routing (allergen / macro / category), if any. */
const exactRoute = (
  keyword: string,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- RoutedIntents carries Float32Array vectors, which have no readonly variant; only read here
  intents: Readonly<RoutedIntents>
): Understood | null => {
  const allergen = intents.allergen.find((i) => i.keyword === keyword);
  if (allergen !== undefined) {
    return { as: `allergen: ${allergen.allergen}`, routedTo: allergen.channel };
  }
  const macro = intents.macro.find((i) => i.keyword === keyword);
  if (macro !== undefined) {
    const { op } = macro;
    const how =
      op.kind === "high" || op.kind === "low"
        ? `${op.kind === "high" ? "dużo" : "mało"} (percentile vs. the day's offers)`
        : `${op.kind} ${op.value}`;
    return {
      as: `macro: ${MACRO_WORDS[macro.field] ?? macro.field} ${how}`,
      routedTo: macro.channel,
    };
  }
  const category = intents.category.find((i) => i.keyword === keyword);
  if (category !== undefined) {
    return {
      as: `category: ${category.category} (${category.patterns.length} ingredient patterns)`,
      routedTo: category.channel,
    };
  }
  return null;
};

/** keyword → source → chosen meals it hit. */
const countHits = (
  offers: readonly Readonly<RankedDayOffer>[]
): ReadonlyMap<string, ReadonlyMap<string, number>> => {
  const out = new Map<string, Map<string, number>>();
  for (const o of offers) {
    for (const p of o.picks) {
      for (const h of p.meal.hits) {
        const bySource = out.get(h.keyword) ?? new Map<string, number>();
        bySource.set(h.source, (bySource.get(h.source) ?? 0) + 1);
        out.set(h.keyword, bySource);
      }
    }
  }
  return out;
};

const SEMANTIC_ONLY =
  "No ingredient or dish name contains this word; matched by semantic similarity only, which is weak evidence. Check the meal names, or rephrase as an ingredient.";

/**
 * How each keyword was routed and whether it landed. The two things an agent
 * cannot see from scores alone: "bez glutenu" silently moving to the other
 * list, and a word the corpus doesn't know being matched by embedding
 * similarity only.
 */
export const reportKeywords = (
  input: Readonly<{ prefer: readonly string[]; avoid: readonly string[] }>,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- RoutedIntents carries Float32Array vectors, which have no readonly variant; only read here
  intents: Readonly<RoutedIntents>,
  offers: readonly Readonly<RankedDayOffer>[]
): KeywordReport[] => {
  const hits = countHits(offers);
  const report = (keyword: string, list: List): KeywordReport => {
    const sources = hits.get(keyword) ?? new Map<string, number>();
    const matched = [...sources.values()].reduce((a, b) => a + b, 0);
    const exact = exactRoute(keyword, intents);
    const routedTo =
      exact?.routedTo ??
      intents.ingredient.find((i) => i.keyword === keyword)?.channel ??
      list;
    const negated =
      routedTo === list
        ? null
        : `negated — scored on the ${routedTo} list ("bez …" means without)`;
    const lexical = sources.get("ingredient") ?? 0;
    let note = negated;
    if (exact === null && lexical === 0 && matched > 0) {
      note = SEMANTIC_ONLY;
    } else if (matched === 0) {
      note = negated ?? "Matched nothing in the chosen meals.";
    }
    const fallThrough =
      lexical > 0
        ? "ingredient / dish name (lexical)"
        : "free text (ingredient, then semantic fallback)";
    const understood = exact?.as ?? fallThrough;
    return {
      keyword,
      list,
      matched_meals: matched,
      note,
      understood_as: understood,
    };
  };
  return [
    ...input.prefer.map((k) => report(k, "prefer")),
    ...input.avoid.map((k) => report(k, "avoid")),
  ];
};

export const weekday = weekdayShortPl;
