import { z } from "zod";
import { anonGet } from "@/mcp/api";

export const getMealOptionsInputSchema = z.object({
  company_id: z.string().min(1),
  diet_calories_id: z.number().int().positive(),
  city_id: z.number().int().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  base_meal_ids: z.array(z.number().int().positive()).optional(),
  is_menu_configuration: z.boolean(),
  tier_id: z.number().int().positive().optional(),
});

export type GetMealOptionsInput = z.infer<typeof getMealOptionsInputSchema>;

interface MealOptionShape {
  dietCaloriesMealId?: number;
  name?: string;
  label?: string | null;
  info?: string | null;
  thermo?: string | null;
  reviewsNumber?: number | null;
  reviewsScore?: number | null;
}

interface MealShape {
  name?: string;
  baseDietCaloriesMealId?: number;
  options?: MealOptionShape[];
}

interface MealApiResponse {
  date?: string;
  calories?: number;
  meals?: MealShape[];
}

function normalizeMealsResponse(response: MealApiResponse, fallbackDate: string) {
  const meals = Array.isArray(response.meals) ? response.meals : [];

  return {
    date: response.date ?? fallbackDate,
    calories: response.calories ?? null,
    meals: meals.map((meal) => ({
      name: meal.name ?? null,
      base_diet_calories_meal_id: meal.baseDietCaloriesMealId ?? null,
      options: (meal.options ?? []).map((option) => ({
        diet_calories_meal_id: option.dietCaloriesMealId ?? null,
        name: option.name ?? null,
        label: option.label ?? null,
        info: option.info ?? null,
        thermo: option.thermo ?? null,
        reviews_number: option.reviewsNumber ?? null,
        reviews_score: option.reviewsScore ?? null,
      })),
    })),
  };
}

export async function getMealOptionsTool(input: GetMealOptionsInput) {
  let response: MealApiResponse;

  if (input.is_menu_configuration) {
    if (!input.base_meal_ids || input.base_meal_ids.length === 0) {
      throw new Error("base_meal_ids is required for menu-configuration diets");
    }
    if (!input.tier_id) {
      throw new Error("tier_id is required for menu-configuration diets");
    }

    const params = new URLSearchParams({
      date: input.date,
      cityId: String(input.city_id),
      dietCaloriesId: String(input.diet_calories_id),
      dietCaloriesMealIds: input.base_meal_ids.join(","),
      tierId: String(input.tier_id),
    });

    response = await anonGet<MealApiResponse>(
      `/api/mobile/open/order-form/steps/menu-configuration/meals?${params.toString()}`,
      input.company_id
    );
  } else {
    const path = `/api/mobile/open/company-card/${encodeURIComponent(
      input.company_id
    )}/menu/${input.diet_calories_id}/city/${input.city_id}/date/${input.date}`;

    response = await anonGet<MealApiResponse>(path, input.company_id);
  }

  return normalizeMealsResponse(response, input.date);
}
