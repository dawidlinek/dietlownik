import { z } from "zod";

import { getRankedOffersForDay } from "@/lib/queries";
import { defineTool } from "@/mcp/tool";

// Preference-aware day ranking. Wraps `lib/queries.ts#getRankedOffersForDay`
// behind the MCP tool surface so an agent can supply free-form Polish prefer/
// avoid keywords and get back ranked per-day offers + per-slot picks for the
// given city/date. City resolution piggybacks on the same DB-first resolver
// used by `find_diets` / `get_menu`.

const inputSchema = z.object({
  avoid: z
    .array(z.string().min(1))
    .max(15)
    .default([])
    .describe(
      "Negative preferences. Same vocabulary as prefer. Each hit subtracts W_AVOID."
    ),
  city: z
    .string()
    .min(1)
    .describe(
      "City name (Polish, e.g. 'Wrocław'). Resolved server-side; never pass an id."
    ),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u)
    .describe("ISO yyyy-mm-dd date to rank menus for."),
  kcal_max: z.number().int().positive().optional(),
  kcal_min: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(20).default(10),
  order_days: z.number().int().min(1).max(30).default(5),
  prefer: z
    .array(z.string().min(1))
    .max(15)
    .default([])
    .describe(
      "Positive preferences. Free-form: ingredients ('kurczak'), categories ('strączkowe'), macros ('dużo białka'), flavors. Each hit adds +W_PREFER to the meal's score."
    ),
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

const outputSchema = z.object({
  city: z.string(),
  considered_count: z.number(),
  date: z.string(),
  offers: z.array(offerSchema),
});

export const rank_day = defineTool({
  annotations: { openWorldHint: false, readOnlyHint: true },
  description:
    "Rank catering diet offers for a single day in a city against free-form " +
    "Polish prefer/avoid keywords. Routes keywords across four channels " +
    "(allergens, ingredient categories, macros, semantic embeddings) and " +
    "surfaces per-slot picks plus a signed score for each offer. Returns " +
    "opaque `offer_id` tokens compatible with `get_menu` / `quote_order` / " +
    "`place_order`.",
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ctx (ToolContext) embeds the DietlyClient class instance; tool only invokes its public methods
  execute: async (input, ctx) => {
    const resolved = await ctx.client.cities.resolve(input.city);

    const result = await getRankedOffersForDay({
      avoid: input.avoid,
      cityId: resolved.id,
      date: input.date,
      kcalMax: input.kcal_max,
      kcalMin: input.kcal_min,
      limit: input.limit,
      orderDays: input.order_days,
      prefer: input.prefer,
      weights: input.weights,
    });

    // getRankedOffersForDay returns deeply-readonly arrays/objects; the Zod
    // outputSchema models them as mutable `z.array(...)`. The values are
    // structurally identical — the cast just widens the static type. The
    // dispatcher re-validates via `outputSchema.safeParse` so any drift
    // (extra/missing fields) still gets caught at runtime.
    return {
      city: resolved.name,
      considered_count: result.considered_count,
      date: input.date,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- widens readonly arrays to the mutable outputSchema shape; runtime validated by the dispatcher
      offers: result.offers as unknown as z.infer<typeof offerSchema>[],
    };
  },
  inputSchema,
  name: "rank_day",
  outputSchema,
});
