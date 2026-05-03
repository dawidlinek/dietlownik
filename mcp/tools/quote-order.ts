import { z } from "zod";

import { parseOfferId } from "@/mcp/offer";
import { defineTool } from "@/mcp/tool";
import type { PriceResponse } from "@/scraper/types";

const inputSchema = z.object({
  city: z.string().min(1).describe("City name (Polish)."),
  dates: z
    .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
    .min(1)
    .max(30)
    .describe(
      "ISO yyyy-mm-dd delivery dates. dietly prices are tiered by the count: 5/10/20+ days unlock progressively bigger order-length discounts."
    ),
  offer_id: z.string().describe("Opaque token from find_diets."),
  promo_codes: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Optional promo codes to apply. dietly does NOT stack with order-length discount — picks the bigger one."
    ),
});

const outputSchema = z.object({
  city: z.object({ id: z.number(), name: z.string() }),
  days_count: z.number(),
  offer_id: z.string(),
  per_day: z.object({
    final_price: z
      .number()
      .nullable()
      .describe("PLN, after order-length + promo discounts."),
    list_price: z.number().nullable().describe("PLN, before discounts."),
  }),
  promo_applied: z.array(z.string()),
  totals: z.object({
    delivery_discount: z.number().nullable(),
    delivery_total: z.number().nullable(),
    final_total: z.number().nullable(),
    list_total: z.number().nullable(),
    order_length_discount: z.number().nullable(),
    promo_discount: z.number().nullable(),
  }),
});

interface QuoteRequestBody {
  cityId: number;
  deliveryDates: string[];
  dietCaloriesId: number;
  promoCodes: string[];
  testOrder: false;
  tierDietOptionId?: string;
}

export const quote_order = defineTool({
  annotations: {
    idempotentHint: true,
    openWorldHint: true,
    readOnlyHint: true,
  },
  description:
    "Price-only quote for a dietly offer over the given dates. Hits " +
    "dietly's calculate-price endpoint and returns the per-day + total " +
    "breakdown (list, final, delivery, order-length discount, promo " +
    "discount). No order is placed and no auth is required — use this " +
    "to answer 'how much would X cost?' without committing.",
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ctx (ToolContext) embeds the DietlyClient class instance; tool only invokes its public methods
  execute: async (input, ctx) => {
    // parseOfferId throws OfferIdError on malformed input; the tool dispatcher's
    // toErrorResult surfaces the message as an isError text result for free.
    const offer = parseOfferId(input.offer_id);
    const city = await ctx.client.cities.resolve(input.city);
    const promoCodes = input.promo_codes ?? [];
    const includeTdo =
      offer.is_menu_configuration &&
      offer.tier_diet_option_id !== undefined &&
      offer.tier_diet_option_id !== "";

    const body: QuoteRequestBody = {
      cityId: city.id,
      deliveryDates: [...input.dates],
      dietCaloriesId: offer.diet_calories_id,
      promoCodes: [...promoCodes],
      testOrder: false,
      ...(includeTdo && offer.tier_diet_option_id !== undefined
        ? { tierDietOptionId: offer.tier_diet_option_id }
        : {}),
    };

    const path = `/api/mobile/open/company-card/${encodeURIComponent(
      offer.company_id
    )}/quick-order/calculate-price`;
    const result = await ctx.client.anonPost<PriceResponse>(
      path,
      body,
      offer.company_id
    );

    const { cart } = result;
    const [item] = result.items;

    return {
      city: { id: city.id, name: city.name },
      days_count: input.dates.length,
      offer_id: input.offer_id,
      per_day: {
        final_price: item?.perDayDietWithDiscountsCost ?? null,
        list_price: item?.perDayDietCost ?? null,
      },
      promo_applied: [...promoCodes],
      totals: {
        // dietly's PriceCart names this `totalDeliveriesOnDateDiscount`; surfaced as delivery_discount in our output
        delivery_discount: cart.totalDeliveriesOnDateDiscount ?? null,
        delivery_total: cart.totalDeliveryCost ?? null,
        final_total: cart.totalCostToPay ?? null,
        list_total: cart.totalCostWithoutDiscounts ?? null,
        order_length_discount: cart.totalOrderLengthDiscount ?? null,
        promo_discount: cart.totalPromoCodeDiscount ?? null,
      },
    };
  },
  inputSchema,
  name: "quote_order",
  outputSchema,
});
