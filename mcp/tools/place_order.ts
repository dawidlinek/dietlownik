import { z } from "zod";
import { authPost } from "@/mcp/api";

export const placeOrderInputSchema = z.object({
  email: z.string().email(),
  company_id: z.string().min(1),
  profile_address_id: z.number().int().positive(),
  diet_calories_id: z.number().int().positive(),
  tier_diet_option_id: z.string().min(1).optional(),
  delivery_dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1),
  meal_selections: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        meals: z.array(
          z.object({
            diet_calories_meal_id: z.number().int().positive(),
          })
        ),
      })
    )
    .min(1),
  promo_codes: z.array(z.string().min(1)).optional(),
  test_order: z.boolean().optional(),
});

export type PlaceOrderInput = z.infer<typeof placeOrderInputSchema>;

interface DeliveryMealPayload {
  amount: 1;
  dietCaloriesMealId: number;
}

interface SelectionPayload {
  date: string;
  meals: DeliveryMealPayload[];
}

interface PlaceOrderResponse {
  paymentUrl?: {
    paymentUrl?: string;
    paymentUrlWithCost?: {
      url?: string;
    };
  };
  orders?: Array<{
    orderId?: number;
  }>;
}

function randomItemId(length = 20): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function normalizeSelections(input: PlaceOrderInput): SelectionPayload[] {
  return input.meal_selections.map((selection) => ({
    date: selection.date,
    meals: selection.meals.map((meal) => ({
      amount: 1 as const,
      dietCaloriesMealId: meal.diet_calories_meal_id,
    })),
  }));
}

export async function placeOrderTool(input: PlaceOrderInput) {
  const selections = normalizeSelections(input);
  const defaultMeals = selections[0]?.meals ?? [];

  const customDeliveryMeals: Record<string, DeliveryMealPayload[]> = {};
  for (const selection of selections) {
    customDeliveryMeals[selection.date] = selection.meals;
  }

  const payload: Record<string, unknown> = {
    clientPreferences: [],
    promoCodes: input.promo_codes ?? [],
    lang: "pl",
    newProfileAddress: null,
    newProfile: null,
    newPassword: null,
    signUp: false,
    invoiceData: null,
    originId: null,
    profilePreferences: [],
    loyaltyProgramPoints: 0,
    loyaltyProgramPointsGlobal: 0,
    companyId: input.company_id,
    paymentRedirectUrl: {
      defaultUrl: "dietly://mobile/payment-default",
      failureUrl: "dietly://mobile/payment-failure",
      successUrl: "dietly://mobile/payment-successful",
    },
    simpleOrders: [
      {
        itemId: randomItemId(20),
        deliveryDates: input.delivery_dates,
        hourPreference: "",
        invoice: false,
        note: "",
        paymentNote: "",
        paymentType: "ONLINE",
        pickupPointId: null,
        profileAddressId: input.profile_address_id,
        addressId: null,
        pickupPointDiscount: null,
        utmMap: {},
        testOrder: input.test_order ?? false,
        dietCaloriesId: input.diet_calories_id,
        customDeliveryMeals,
        sideOrders: [],
        deliveryMeals: defaultMeals,
        ...(input.tier_diet_option_id
          ? { tierDietOptionId: input.tier_diet_option_id }
          : {}),
      },
    ],
  };

  const response = await authPost<PlaceOrderResponse>(
    input.email,
    "/api/mobile/profile/shopping-cart/order",
    payload,
    input.company_id
  );

  const paymentUrl =
    response.paymentUrl?.paymentUrl ??
    response.paymentUrl?.paymentUrlWithCost?.url ??
    null;
  const orderId = response.orders?.[0]?.orderId ?? null;

  return {
    payment_url: paymentUrl,
    order_id: orderId,
    raw: response,
  };
}
