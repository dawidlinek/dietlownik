import { z } from "zod";

import { parseOfferId } from "@/mcp/offer";
import { defineTool } from "@/mcp/tool";
import { futureWeekdays } from "@/scraper/api";

// Note: `city` is taken alongside `offer_id` because the offer encoding is
// intentionally city-agnostic — the same offer can be priced in any city the
// company serves. Keeping city as a separate arg avoids re-issuing offer_ids
// when the agent wants to look up the same diet's menu in another city.
const inputSchema = z.object({
  city: z
    .string()
    .min(1)
    .describe("City name (Polish). Same one used in find_diets."),
  dates: z
    .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
    .min(1)
    .max(14)
    .optional()
    .describe(
      "Up to 14 ISO yyyy-mm-dd dates. Defaults to the next 7 weekdays."
    ),
  offer_id: z.string().describe("Opaque token from find_diets."),
});

const outputSchema = z.object({
  days: z.array(
    z.object({
      calories: z.number().nullable(),
      date: z.string(),
      slots: z.array(
        z.object({
          default_pick_id: z
            .string()
            .nullable()
            .describe(
              "Opaque pick token. Used by default in quote_order/place_order if you don't specify picks."
            ),
          options: z.array(
            z.object({
              info: z
                .string()
                .nullable()
                .describe(
                  "Short string with kcal + macros (e.g. '300 kcal • B:19g • W:30g • T:11g')."
                ),
              label: z.string().nullable(),
              name: z.string().nullable(),
              pick_id: z
                .string()
                .describe(
                  "Opaque token; pass in `picks` to quote_order/place_order."
                ),
              reviews_number: z.number().nullable(),
              reviews_score: z.number().nullable(),
              thermo: z
                .string()
                .nullable()
                .describe("'HOT' or 'COLD' or null."),
            })
          ),
          slot_name: z
            .string()
            .nullable()
            .describe("e.g. 'Śniadanie', 'Lunch', 'Obiad'."),
        })
      ),
    })
  ),
  is_configurable: z.boolean(),
  offer_id: z.string(),
});

interface MealOptionShape {
  readonly dietCaloriesMealId?: number;
  readonly info?: string | null;
  readonly label?: string | null;
  readonly name?: string;
  readonly reviewsNumber?: number | null;
  readonly reviewsScore?: number | null;
  readonly thermo?: string | null;
}

interface MealShape {
  readonly baseDietCaloriesMealId?: number;
  readonly name?: string;
  readonly options?: readonly MealOptionShape[];
}

interface MealApiResponse {
  readonly calories?: number;
  readonly date?: string;
  readonly meals?: readonly MealShape[];
}

type DaySlot = z.infer<typeof outputSchema>["days"][number]["slots"][number];
type Day = z.infer<typeof outputSchema>["days"][number];

const buildSlot = (meal: Readonly<MealShape>): DaySlot => ({
  default_pick_id:
    meal.baseDietCaloriesMealId === undefined
      ? null
      : String(meal.baseDietCaloriesMealId),
  options: (meal.options ?? []).map((option: Readonly<MealOptionShape>) => ({
    info: option.info ?? null,
    label: option.label ?? null,
    name: option.name ?? null,
    pick_id:
      option.dietCaloriesMealId === undefined
        ? ""
        : String(option.dietCaloriesMealId),
    reviews_number: option.reviewsNumber ?? null,
    reviews_score: option.reviewsScore ?? null,
    thermo: option.thermo ?? null,
  })),
  slot_name: meal.name ?? null,
});

export const get_menu = defineTool({
  annotations: { openWorldHint: true, readOnlyHint: true },
  description:
    "Fetch the live per-day menu for an `offer_id` from find_diets across " +
    "the given dates (defaults to the next 7 weekdays). Each meal slot " +
    "exposes its alternatives as `options[].pick_id` opaque tokens. Pass " +
    "those `pick_id`s in the `picks` arg to `quote_order` / `place_order` " +
    "to override the slot's `default_pick_id`. City is taken separately " +
    "because offers are city-agnostic.",
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ctx (ToolContext) embeds the DietlyClient class instance; tool only invokes its public methods
  execute: async (input, ctx) => {
    const offer = parseOfferId(input.offer_id);
    const city = await ctx.client.cities.resolve(input.city);
    const dates = input.dates ?? futureWeekdays(7);

    const days: Day[] = await Promise.all(
      dates.map(async (date: string): Promise<Day> => {
        const path = `/api/mobile/open/company-card/${encodeURIComponent(
          offer.company_id
        )}/menu/${offer.diet_calories_id}/city/${city.id}/date/${date}`;
        try {
          const response = await ctx.client.anonGet<MealApiResponse>(
            path,
            offer.company_id
          );
          const meals: readonly MealShape[] = response.meals ?? [];
          return {
            calories: response.calories ?? null,
            date: response.date ?? date,
            slots: meals.map(buildSlot),
          };
        } catch {
          // Don't fail the whole call on a single missing day (404s, empty
          // menus, transient errors) — return the date with no slots so the
          // agent still sees the calendar shape.
          return { calories: null, date, slots: [] };
        }
      })
    );

    return {
      days,
      is_configurable: offer.is_menu_configuration,
      offer_id: input.offer_id,
    };
  },
  inputSchema,
  name: "get_menu",
  outputSchema,
});
