import { z } from "zod";

import { sendBasket } from "@/lib/dietly-basket-send";
import { parseOfferId } from "@/mcp/offer";
import { selectionSchema } from "@/mcp/present";
import { defineTool } from "@/mcp/tool";

// The dashboard's "zamów" button: put one catering's days into the user's
// dietly basket. Nothing is ordered or charged — the user opens basket_url,
// reviews it on dietly.pl and pays there. dietly's basket holds a single
// catering, so a mixed plan goes one catering at a time.

const inputSchema = z.object({
  catering: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Catering id to send. Required when the selections span several caterings."
    ),
  city: z.string().min(1).default("Wrocław"),
  promo_codes: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Defaults to the codes the selections carry. A code dietly refuses is dropped, not fatal."
    ),
  replace: z
    .boolean()
    .default(false)
    .describe(
      "Overwrite a basket holding another catering or items the user added on dietly.pl. Ask the user first."
    ),
  selections: z.array(selectionSchema).min(1).max(60),
});

const outputSchema = z.object({
  basket_url: z.string().nullable(),
  diets: z.array(
    z.object({
      dates: z.array(z.string()),
      offer_id: z.string().nullable(),
      per_day: z.number().nullable(),
      total: z.number().nullable(),
    })
  ),
  existing: z
    .object({
      company_id: z.string().nullable(),
      diets: z.number(),
      ours: z.boolean(),
    })
    .nullable()
    .describe("Set when status is 'conflict': what the basket holds now."),
  message: z.string(),
  promo_dropped: z.string().nullable(),
  remaining_caterings: z
    .array(z.string())
    .describe("Other caterings in the selections, still to send."),
  status: z.enum(["sent", "conflict"]),
  total: z.number().nullable(),
});

export const send_to_basket = defineTool({
  annotations: {
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
    readOnlyHint: false,
  },
  description:
    "Put one catering's days from a plan into the user's dietly basket " +
    "(requires `login`). Nothing is ordered or paid: the user opens " +
    "`basket_url`, checks it and pays on dietly.pl. The basket holds one " +
    "catering, so send a mixed plan catering by catering, after the user " +
    "has checked out the previous one. Menu-choice picks are sent as chosen.",
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ctx (ToolContext) embeds the DietlyClient class instance; tool only invokes its public methods
  execute: async (input, ctx) => {
    const email = ctx.client.getDefaultEmail();
    if (email === undefined) {
      throw new Error(
        "Not logged in — call `login` first. (The dashboard's dietly login is separate from this MCP session.)"
      );
    }
    const city = await ctx.client.cities.resolve(input.city);

    const byCatering = new Map<string, typeof input.selections>();
    for (const s of input.selections) {
      const id = parseOfferId(s.offer_id).company_id;
      byCatering.set(id, [...(byCatering.get(id) ?? []), s]);
    }
    const caterings = [...byCatering.keys()];
    const catering =
      input.catering ?? (caterings.length === 1 ? caterings[0] : undefined);
    if (catering === undefined) {
      throw new Error(
        `Selections span ${caterings.length} caterings (${caterings.join(", ")}); dietly's basket holds one. Pass \`catering\`.`
      );
    }
    const chosen = byCatering.get(catering);
    if (chosen === undefined) {
      throw new Error(
        `No selection belongs to ${catering}. Caterings present: ${caterings.join(", ")}.`
      );
    }
    const codes = input.promo_codes ?? [
      ...new Set(
        chosen.map((s) => s.promo_code).filter((c): c is string => c !== null)
      ),
    ];

    // A BasketError (menu changed since the scrape) surfaces as-is.
    const result = await sendBasket(ctx.client, email, {
      cityId: city.id,
      companyId: catering,
      days: chosen.map((s) => ({
        date: s.date,
        offer_id: s.offer_id,
        picks: s.picks.map((p) => ({ meal_id: p.meal_id, slot_name: p.slot })),
      })),
      promoCodes: codes,
      replace: input.replace,
    });
    const remaining = caterings.filter((c) => c !== catering);
    if (result.kind === "conflict") {
      const { existing } = result;
      return {
        basket_url: null,
        diets: [],
        existing,
        message: existing.ours
          ? `The basket holds an earlier dietlownik selection for ${existing.company_id ?? "another catering"}. Re-send with replace: true to swap it.`
          : `The basket holds ${existing.diets} item(s) for ${existing.company_id ?? "a catering"} that the user added on dietly.pl. Ask before re-sending with replace: true — it overwrites them.`,
        promo_dropped: null,
        remaining_caterings: remaining,
        status: "conflict" as const,
        total: null,
      };
    }
    if (result.kind === "not_stored") {
      throw new Error(
        "dietly priced the basket but did not store it. Try again in a moment."
      );
    }
    return {
      basket_url: result.basket_url,
      diets: result.diets.map((d) => ({ ...d, dates: [...d.dates] })),
      existing: null,
      message: `In the basket. The user checks out at ${result.basket_url}.${remaining.length > 0 ? ` Then send the next catering: ${remaining.join(", ")}.` : ""}`,
      promo_dropped: result.promo_dropped,
      remaining_caterings: remaining,
      status: "sent" as const,
      total: result.total,
    };
  },
  inputSchema,
  name: "send_to_basket",
  outputSchema,
});
