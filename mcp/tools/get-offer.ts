import { z } from "zod";

import { getRankedOffersForDay } from "@/lib/queries";
import { parseOfferId } from "@/mcp/offer";
import {
  cardSchema,
  selectionSchema,
  toCard,
  toSelection,
} from "@/mcp/present";
import { defineTool } from "@/mcp/tool";

// The expanded dashboard row: one offer on one day with every slot, every
// dish it could serve there, their macros, ingredients, allergens and hits.
// Scored against the same prefer/avoid so the reasons line up with `plan`.

const keywords = z.array(z.string().min(1)).max(15).default([]);

const inputSchema = z.object({
  avoid: keywords,
  city: z.string().min(1).default("Wrocław"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  offer_id: z.string().min(1).describe("From plan / find_diets."),
  prefer: keywords,
});

const outputSchema = z.object({
  date: z.string(),
  offer: cardSchema,
  selection: selectionSchema.describe(
    "This day as plan would select it. To swap a dish, replace that slot's meal_id with one from other_options."
  ),
});

export const get_offer = defineTool({
  annotations: { openWorldHint: false, readOnlyHint: true },
  description:
    "Everything about one offer on one date: each slot's chosen dish and, " +
    "for menu-choice diets, every other dish you could swap in — with kcal, " +
    "protein, ingredients, allergens and the prefer/avoid hits. Use it to " +
    "check a pick before ordering or to build custom picks for a selection.",
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ctx (ToolContext) embeds the DietlyClient class instance; tool only invokes its public methods
  execute: async (input, ctx) => {
    const parts = parseOfferId(input.offer_id);
    const city = await ctx.client.cities.resolve(input.city);
    const r = await getRankedOffersForDay({
      avoid: input.avoid,
      cityId: city.id,
      date: input.date,
      includeCompanyIds: [parts.company_id],
      limit: 0,
      prefer: input.prefer,
    });
    const offer = r.offers.find((o) => o.offer_id === input.offer_id);
    if (offer === undefined) {
      throw new Error(
        `${input.offer_id} has no menu on ${input.date} in ${city.name}. It may not deliver that day, or the menu wasn't scraped — run plan for that date.`
      );
    }
    return {
      date: input.date,
      offer: toCard(offer, { full: true, meals: true }),
      selection: toSelection(input.date, offer),
    };
  },
  inputSchema,
  name: "get_offer",
  outputSchema,
});
