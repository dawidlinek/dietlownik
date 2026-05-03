import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { defineTool } from "@/mcp/tool";

const inputSchema = z.object({
  company_id: z.string().min(1),
  confirmed: z
    .boolean()
    .default(false)
    .describe(
      "Set to true to skip the in-tool confirmation step. Used as a fallback when the host doesn't support spec elicitation (the tool returns a summary on the first call; re-call with confirmed:true after the user agrees).",
    ),
  delivery_dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1),
  diet_calories_id: z.number().int().positive(),
  email: z.string().email(),
  meal_selections: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        meals: z.array(
          z.object({
            diet_calories_meal_id: z.number().int().positive(),
          }),
        ),
      }),
    )
    .min(1),
  profile_address_id: z.number().int().positive(),
  promo_codes: z.array(z.string().min(1)).optional(),
  test_order: z.boolean().optional(),
  tier_diet_option_id: z.string().min(1).optional(),
});

type PlaceOrderInput = z.infer<typeof inputSchema>;

interface DeliveryMealPayload {
  amount: 1;
  dietCaloriesMealId: number;
}

interface PlaceOrderResponse {
  orders?: Array<{ orderId?: number }>;
  paymentUrl?: {
    paymentUrl?: string;
    paymentUrlWithCost?: { url?: string };
  };
}

function summarizeOrder(input: PlaceOrderInput): string {
  const totalMeals = input.meal_selections.reduce(
    (sum, sel) => sum + sel.meals.length,
    0,
  );
  const days = input.delivery_dates.length;
  const lines = [
    `Company: ${input.company_id}`,
    `Email: ${input.email}`,
    `Profile address: ${input.profile_address_id}`,
    `Diet calories ID: ${input.diet_calories_id}`,
    ...(input.tier_diet_option_id ? [`Tier diet option: ${input.tier_diet_option_id}`] : []),
    `Delivery: ${days} day${days === 1 ? "" : "s"} (${input.delivery_dates[0]} → ${input.delivery_dates[days - 1]})`,
    `Total meals: ${totalMeals}`,
    ...(input.promo_codes?.length ? [`Promo codes: ${input.promo_codes.join(", ")}`] : []),
    `Test order: ${input.test_order ? "YES (no charge)" : "no — REAL CHARGE"}`,
  ];
  return lines.join("\n");
}

function jsonResult(data: unknown): CallToolResult {
  return {
    content: [{ text: JSON.stringify(data), type: "text" }],
    structuredContent:
      data !== null && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : undefined,
  };
}

async function executeOrder(input: PlaceOrderInput, client: import("@/mcp/client").DietlyClient) {
  const customDeliveryMeals: Record<string, DeliveryMealPayload[]> = {};
  for (const selection of input.meal_selections) {
    customDeliveryMeals[selection.date] = selection.meals.map((m) => ({
      amount: 1 as const,
      dietCaloriesMealId: m.diet_calories_meal_id,
    }));
  }
  const defaultMeals = customDeliveryMeals[input.delivery_dates[0]] ?? [];

  const payload: Record<string, unknown> = {
    clientPreferences: [],
    companyId: input.company_id,
    invoiceData: null,
    lang: "pl",
    loyaltyProgramPoints: 0,
    loyaltyProgramPointsGlobal: 0,
    newPassword: null,
    newProfile: null,
    newProfileAddress: null,
    originId: null,
    paymentRedirectUrl: {
      defaultUrl: "dietly://mobile/payment-default",
      failureUrl: "dietly://mobile/payment-failure",
      successUrl: "dietly://mobile/payment-successful",
    },
    profilePreferences: [],
    promoCodes: input.promo_codes ?? [],
    signUp: false,
    simpleOrders: [
      {
        addressId: null,
        customDeliveryMeals,
        deliveryDates: input.delivery_dates,
        deliveryMeals: defaultMeals,
        dietCaloriesId: input.diet_calories_id,
        hourPreference: "",
        invoice: false,
        itemId: crypto.randomUUID().replace(/-/g, "").slice(0, 20),
        note: "",
        paymentNote: "",
        paymentType: "ONLINE",
        pickupPointDiscount: null,
        pickupPointId: null,
        profileAddressId: input.profile_address_id,
        sideOrders: [],
        testOrder: input.test_order ?? false,
        utmMap: {},
        ...(input.tier_diet_option_id
          ? { tierDietOptionId: input.tier_diet_option_id }
          : {}),
      },
    ],
  };

  const response = await client.authPost<PlaceOrderResponse>(
    input.email,
    "/api/mobile/profile/shopping-cart/order",
    payload,
    input.company_id,
  );

  const payment_url =
    response.paymentUrl?.paymentUrl ??
    response.paymentUrl?.paymentUrlWithCost?.url ??
    null;
  const order_id = response.orders?.[0]?.orderId ?? null;

  return { order_id, payment_url, raw: response };
}

export const place_order = defineTool({
  annotations: {
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  description:
    "Create a real Dietly cart order. IRREVERSIBLE — incurs a charge " +
    "unless `test_order: true`. Requires a logged-in email, a " +
    "`profile_address_id` from `login`/`get_profile`, " +
    "`diet_calories_id` from `search_caterings`, and " +
    "`meal_selections` built from `get_meal_options`. " +
    "First call shows a summary and asks for confirmation; " +
    "re-call with `confirmed: true` to actually place. Returns " +
    "payment URL + order ID.",
  execute: async (input, { client, server }) => {
    if (!input.confirmed) {
      const summary = summarizeOrder(input);
      // Try elicitation if the host advertises support; otherwise return a
      // text fallback that asks the agent to re-call with confirmed:true.
      if (server?.getClientCapabilities()?.elicitation) {
        const r = await server.elicitInput({
          message: `Place this order?\n\n${summary}`,
          requestedSchema: {
            properties: {
              confirm: {
                title: input.test_order
                  ? "Place test order"
                  : "Place real order (will charge)",
                type: "boolean",
              },
            },
            required: ["confirm"],
            type: "object",
          },
        });
        if (
          r.action !== "accept" ||
          !(r.content as { confirm?: boolean } | undefined)?.confirm
        ) {
          return jsonResult({ reason: r.action, status: "cancelled", summary });
        }
      } else {
        return jsonResult({
          next: "Show the user this summary. If they agree, re-call place_order with `confirmed: true`.",
          status: "confirmation_required",
          summary,
        });
      }
    }
    return executeOrder(input, client);
  },
  inputSchema,
  name: "place_order",
  // No outputSchema: the success path returns { order_id, payment_url, raw },
  // but the confirmation/cancellation paths return raw CallToolResults.
  // Output validation would have to be a discriminated union; not worth it.
});
