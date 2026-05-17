import { z } from "zod";

import { getWeeklyPlan } from "@/lib/queries";
import { defineTool } from "@/mcp/tool";

// Multi-day plan over `getRankedOffersForDay`. Picks the per-day argmax,
// surfaces a handful of alternates, and computes a bundle hint when a single
// company dominates the week. Same prefer/avoid vocabulary as `rank_day`.

const inputSchema = z.object({
  alt_limit: z.number().int().min(0).max(5).default(3),
  avoid: z.array(z.string().min(1)).max(15).default([]),
  city: z
    .string()
    .min(1)
    .describe(
      "City name (Polish, e.g. 'Wrocław'). Resolved server-side; never pass an id."
    ),
  dates: z
    .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/u))
    .min(1)
    .max(14)
    .describe("ISO yyyy-mm-dd dates. Up to 14."),
  kcal_max: z.number().int().positive().optional(),
  kcal_min: z.number().int().positive().optional(),
  prefer: z.array(z.string().min(1)).max(15).default([]),
  weights: z
    .object({
      avoid: z.number().positive().default(1),
      prefer: z.number().positive().default(1),
    })
    .optional(),
});

const hitSchema = z.object({
  channel: z.enum(["prefer", "avoid"]),
  contribution: z.number(),
  keyword: z.string(),
  penalty: z.number(),
  reason: z.string(),
  source: z.enum(["allergen", "category", "macro", "embedding"]),
});

const mealSchema = z.object({
  hits: z.array(hitSchema),
  meal_id: z.number(),
  meal_name: z.string(),
  score: z.number(),
});

const pickSchema = z.object({
  is_default: z.boolean(),
  meal: mealSchema,
  slot_name: z.string(),
});

const verdictSchema = z.object({
  n_slots: z.number(),
  score_best: z.number(),
  score_default: z.number(),
});

const offerSchema = z.object({
  calories: z.number().nullable(),
  company: z.object({ id: z.string(), name: z.string().nullable() }),
  diet: z.object({
    name: z.string().nullable(),
    tag: z.string().nullable(),
  }),
  is_menu_configuration: z.boolean(),
  offer_id: z.string(),
  picks: z.array(pickSchema),
  picks_default: z.array(pickSchema).nullable(),
  price_per_day: z.number().nullable(),
  tier: z.object({ name: z.string().nullable() }).nullable(),
  verdict: verdictSchema,
});

const dayShape = z.object({
  alternates: z.array(offerSchema),
  date: z.string(),
  note: z.string().nullable(),
  top: offerSchema.nullable(),
});

const outputSchema = z.object({
  city: z.object({ id: z.number(), name: z.string() }),
  days: z.array(dayShape),
  summary: z.object({
    avg_score_best: z.number(),
    bundle_hint: z.string().nullable(),
    distinct_caterings: z.number(),
    estimated_total_price: z.number(),
  }),
});

export const plan_week = defineTool({
  annotations: { openWorldHint: false, readOnlyHint: true },
  description:
    "Plan a multi-day catering schedule by picking the best-scoring offer " +
    "per day against free-form prefer/avoid keywords. Surfaces up to " +
    "`alt_limit` alternates per day plus a bundle hint when a single " +
    "company dominates ≥80% of days. Same vocabulary as `rank_day`.",
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ctx (ToolContext) embeds the DietlyClient class instance; tool only invokes its public methods
  execute: async (input, ctx) => {
    const resolved = await ctx.client.cities.resolve(input.city);

    const plan = await getWeeklyPlan({
      altLimit: input.alt_limit,
      avoid: input.avoid,
      cityId: resolved.id,
      dates: input.dates,
      kcalMax: input.kcal_max,
      kcalMin: input.kcal_min,
      prefer: input.prefer,
      weights: input.weights,
    });

    // getWeeklyPlan resolves the city name via its own internal lookup; that
    // value may diverge from the resolver's canonical name if the row was
    // ever upserted with mixed-case input. Trust the resolver (it
    // canonicalises to the dietly-side name) for the output envelope.
    return {
      city: { id: resolved.id, name: resolved.name },
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- widens readonly arrays from getWeeklyPlan to the mutable outputSchema shape; runtime validated by the dispatcher
      days: plan.days as unknown as z.infer<typeof dayShape>[],
      summary: plan.summary,
    };
  },
  inputSchema,
  name: "plan_week",
  outputSchema,
});
