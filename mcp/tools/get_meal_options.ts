import { z } from "zod";

import { defineTool } from "@/mcp/tool";

const inputSchema = z
  .object({
    base_meal_ids: z.array(z.number().int().positive()).optional(),
    city_id: z.number().int().positive(),
    company_id: z.string().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    diet_calories_id: z.number().int().positive(),
    is_menu_configuration: z.boolean(),
    tier_id: z.number().int().positive().optional(),
  })
  .refine(
    (
      v: Readonly<{
        readonly is_menu_configuration: boolean;
        readonly tier_id?: number;
      }>
    ) => !v.is_menu_configuration || v.tier_id !== undefined,
    {
      message: "tier_id is required when is_menu_configuration is true",
      path: ["tier_id"],
    }
  )
  .refine(
    (
      v: Readonly<{
        readonly base_meal_ids?: readonly number[];
        readonly is_menu_configuration: boolean;
      }>
    ) =>
      !v.is_menu_configuration ||
      (v.base_meal_ids !== undefined && v.base_meal_ids.length > 0),
    {
      message:
        "base_meal_ids must be non-empty when is_menu_configuration is true",
      path: ["base_meal_ids"],
    }
  );

const outputSchema = z.object({
  calories: z.number().nullable(),
  date: z.string(),
  meals: z.array(z.unknown()),
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

const normalizeMealsResponse = (
  response: MealApiResponse,
  fallbackDate: string
) => {
  const meals: readonly MealShape[] = response.meals ?? [];
  return {
    calories: response.calories ?? null,
    date: response.date ?? fallbackDate,
    meals: meals.map((meal: Readonly<MealShape>) => ({
      base_diet_calories_meal_id: meal.baseDietCaloriesMealId ?? null,
      name: meal.name ?? null,
      options: (meal.options ?? []).map(
        (option: Readonly<MealOptionShape>) => ({
          diet_calories_meal_id: option.dietCaloriesMealId ?? null,
          info: option.info ?? null,
          label: option.label ?? null,
          name: option.name ?? null,
          reviews_number: option.reviewsNumber ?? null,
          reviews_score: option.reviewsScore ?? null,
          thermo: option.thermo ?? null,
        })
      ),
    })),
  };
};

export const get_meal_options = defineTool({
  annotations: { openWorldHint: true, readOnlyHint: true },
  description:
    "Fetch live per-day meal slots + `diet_calories_meal_id` values " +
    "from dietly. For fixed diets, set `is_menu_configuration: false`. " +
    "For menu-configuration diets, set true and pass `tier_id` plus " +
    "the `base_meal_ids` from a prior call. Use the returned " +
    "`diet_calories_meal_id` values when building `place_order`'s " +
    "`meal_selections`.",
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ctx (ToolContext) embeds the DietlyClient class instance; tool only invokes its public methods
  execute: async (input, ctx) => {
    let response: MealApiResponse;
    if (input.is_menu_configuration) {
      // Schema refinements above guarantee tier_id + base_meal_ids are set.
      if (input.tier_id === undefined || input.base_meal_ids === undefined) {
        throw new Error(
          "tier_id and base_meal_ids are required when is_menu_configuration is true"
        );
      }
      const params = new URLSearchParams({
        cityId: String(input.city_id),
        date: input.date,
        dietCaloriesId: String(input.diet_calories_id),
        dietCaloriesMealIds: input.base_meal_ids.join(","),
        tierId: String(input.tier_id),
      });
      response = await ctx.client.anonGet<MealApiResponse>(
        `/api/mobile/open/order-form/steps/menu-configuration/meals?${params.toString()}`,
        input.company_id
      );
    } else {
      const path = `/api/mobile/open/company-card/${encodeURIComponent(
        input.company_id
      )}/menu/${input.diet_calories_id}/city/${input.city_id}/date/${input.date}`;
      response = await ctx.client.anonGet<MealApiResponse>(
        path,
        input.company_id
      );
    }
    return normalizeMealsResponse(response, input.date);
  },
  inputSchema,
  name: "get_meal_options",
  outputSchema,
});
