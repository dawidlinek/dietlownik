import { z } from "zod";

import { parseOfferId } from "@/mcp/offer";
import { round, selectionSchema } from "@/mcp/present";
import { defineTool } from "@/mcp/tool";
import { HttpError } from "@/scraper/api";
import type { PriceResponse } from "@/scraper/types";

// Live re-pricing of a plan. Scraped prices can be days old and assume a
// promo code; this asks dietly's calculate-price for each offer's dates, with
// the code the plan assumed, and says plainly when dietly refused the code.
// Nothing is ordered and no login is needed.

const inputSchema = z.object({
  city: z.string().min(1).default("Wrocław"),
  promo_codes: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Override the codes carried by each selection. [] quotes list prices."
    ),
  selections: z
    .array(selectionSchema)
    .min(1)
    .max(60)
    .describe(
      "From plan (or get_offer). Days of one offer are quoted together."
    ),
});

const lineSchema = z.object({
  catering: z.string(),
  dates: z.array(z.string()),
  delivery: z.number().describe("Included in total."),
  list_total: z.number(),
  offer_id: z.string(),
  order_length_discount: z.number(),
  per_day: z.number().describe("total / days, delivery included."),
  promo: z.object({
    applied: z.boolean(),
    code: z.string().nullable(),
    discount: z.number(),
    rejected: z
      .string()
      .nullable()
      .describe("dietly's reason, when it refused the code."),
  }),
  total: z.number(),
});

const outputSchema = z.object({
  city: z.string(),
  lines: z.array(lineSchema),
  total: z.number(),
});

interface Group {
  readonly code: string | null;
  readonly dates: readonly string[];
}

interface QuoteBody {
  cityId: number;
  deliveryDates: string[];
  dietCaloriesId: number;
  promoCodes: string[];
  testOrder: false;
  tierDietOptionId?: string;
}

/** dietly answers a refused code with HTTP 490 and a Polish message. */
const refusal = (error: unknown): string | null => {
  if (!(error instanceof HttpError) || error.status !== 490) {
    return null;
  }
  try {
    const body: unknown = JSON.parse(error.bodySnippet);
    if (
      body !== null &&
      typeof body === "object" &&
      "message" in body &&
      typeof body.message === "string"
    ) {
      return body.message;
    }
  } catch {
    // Non-JSON body — fall through to the generic reason.
  }
  return "dietly refused the code";
};

export const quote = defineTool({
  annotations: {
    idempotentHint: true,
    openWorldHint: true,
    readOnlyHint: true,
  },
  description:
    "Live price check on dietly for a plan's `selections` (or any offer/date " +
    "list): per offer the list total, promo discount (and whether dietly " +
    "accepted the code), order-length discount, delivery and final total. " +
    "Nothing is ordered, no login needed. Run it before send_to_basket — " +
    "plan's prices are from the last scrape.",
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ctx (ToolContext) embeds the DietlyClient class instance; tool only invokes its public methods
  execute: async (input, ctx) => {
    const city = await ctx.client.cities.resolve(input.city);

    const groups = new Map<string, Group>();
    for (const s of input.selections) {
      const prev = groups.get(s.offer_id);
      groups.set(s.offer_id, {
        code: prev?.code ?? s.promo_code,
        dates: [...(prev?.dates ?? []), s.date],
      });
    }

    const lines = await Promise.all(
      [...groups].map(async ([offerId, g]: readonly [string, Group]) => {
        const offer = parseOfferId(offerId);
        const dates = [...new Set(g.dates)].toSorted();
        const codes = input.promo_codes ?? (g.code === null ? [] : [g.code]);
        const path = `/api/mobile/open/company-card/${encodeURIComponent(offer.company_id)}/quick-order/calculate-price`;
        const ask = async (promoCodes: readonly string[]) => {
          const body: QuoteBody = {
            cityId: city.id,
            deliveryDates: dates,
            dietCaloriesId: offer.diet_calories_id,
            promoCodes: [...promoCodes],
            testOrder: false,
            ...(offer.is_menu_configuration &&
            offer.tier_diet_option_id !== undefined
              ? { tierDietOptionId: offer.tier_diet_option_id }
              : {}),
          };
          const res = await ctx.client.anonPost<PriceResponse>(
            path,
            body,
            offer.company_id
          );
          return res;
        };
        let rejected: string | null = null;
        let res: PriceResponse;
        try {
          res = await ask(codes);
        } catch (error) {
          rejected = codes.length > 0 ? refusal(error) : null;
          if (rejected === null) {
            throw error;
          }
          res = await ask([]);
        }
        const { cart } = res;
        const total = cart.totalCostToPay ?? 0;
        const promoDiscount = cart.totalPromoCodeDiscount ?? 0;
        return {
          catering: offer.company_id,
          dates,
          delivery: round(cart.totalDeliveryCost ?? 0),
          list_total: round(cart.totalCostWithoutDiscounts ?? 0),
          offer_id: offerId,
          order_length_discount: round(cart.totalOrderLengthDiscount ?? 0),
          per_day: round(total / dates.length),
          promo: {
            applied: promoDiscount > 0,
            code: codes[0] ?? null,
            discount: round(promoDiscount),
            rejected,
          },
          total: round(total),
        };
      })
    );

    return {
      city: city.name,
      lines,
      total: round(
        lines.reduce(
          (a: number, l: Readonly<{ total: number }>) => a + l.total,
          0
        )
      ),
    };
  },
  inputSchema,
  name: "quote",
  outputSchema,
});
