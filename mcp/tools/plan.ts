import { z } from "zod";

import { routePreferences } from "@/lib/preference-router";
import { getAvailableDates, getRankedOffersForDay } from "@/lib/queries";
import type { RankedDayOffer } from "@/lib/queries";
import { dateSchemaNote, orderableFrom } from "@/mcp/dates";
import {
  cardSchema,
  keywordSchema,
  reportKeywords,
  round,
  selectionSchema,
  sortSchema,
  toCard,
  toSelection,
  weekday,
} from "@/mcp/present";
import { defineTool } from "@/mcp/tool";

// The dashboard's home page as one call: for each date, the offer that wins
// under the chosen sort (with its meals and why they scored), a few
// alternatives from other caterings, then the plan's honest math — list
// total, promo savings, final total, which caterings and codes it takes.
// `selections` is the plan in the shape `quote` and `send_to_basket` take.

const DEFAULT_KCAL_MIN = 1500;
const DEFAULT_KCAL_MAX = 2000;

const keywords = z.array(z.string().min(1)).max(15).default([]);

const inputSchema = z.object({
  alternatives: z
    .number()
    .int()
    .min(0)
    .max(10)
    .default(3)
    .describe(
      "Runners-up per day, one per catering, same sort. Raise it to compare a single day."
    ),
  avoid: keywords.describe(
    "unikam — allergens (gluten, jaja), categories (psiankowate), ingredients (grzyby), macros (dużo cukru)."
  ),
  city: z.string().min(1).default("Wrocław"),
  dates: z
    .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/u))
    .min(1)
    .max(14)
    .optional()
    .describe(dateSchemaNote),
  detail: z
    .enum(["summary", "meals", "full"])
    .default("meals")
    .describe(
      "summary: numbers only · meals: the winner's dishes and hit reasons · full: plus ingredients, allergens and every other dish in menu-choice slots."
    ),
  exclude: z
    .array(z.string().min(1))
    .default([])
    .describe("Catering ids to leave out (get_context lists them)."),
  include_shared_packages: z
    .boolean()
    .default(false)
    .describe(
      "Include 'dla dwojga' / 'duo' / 'duet' packages. Off by default: they feed two people, so their price and slot count aren't comparable."
    ),
  kcal_max: z.number().int().positive().default(DEFAULT_KCAL_MAX),
  kcal_min: z.number().int().positive().default(DEFAULT_KCAL_MIN),
  only: z
    .array(z.string().min(1))
    .default([])
    .describe("Restrict to these catering ids."),
  prefer: keywords.describe(
    "lubię — ingredients (kurczak, łosoś), macros (dużo białka, mało cukru), categories (strączkowe)."
  ),
  sort: sortSchema,
});

const dayOutput = z.object({
  alternatives: z.array(cardSchema),
  considered: z.number().describe("Offers that had a menu that day."),
  date: z.string(),
  note: z.string().nullable(),
  pick: cardSchema.nullable(),
  weekday: z.string(),
});

const outputSchema = z.object({
  days: z.array(dayOutput),
  keywords: z.array(keywordSchema),
  next: z.string(),
  query: z.object({
    city: z.string(),
    dates: z.array(z.string()),
    kcal: z.string(),
    sort: z.string(),
  }),
  selections: z
    .array(selectionSchema)
    .describe(
      "The picks, one per day. Pass to quote / send_to_basket as-is, or edit picks to swap dishes."
    ),
  totals: z.object({
    caterings: z.array(
      z.object({
        dates: z.array(z.string()),
        id: z.string(),
        name: z.string(),
        promo_codes: z.array(z.string()),
        subtotal: z.number(),
      })
    ),
    days: z.number(),
    list_total: z.number().describe("Without promo codes."),
    savings: z.number(),
    total: z.number().describe("Sum of per-day prices, promos applied."),
  }),
});

type Day = z.infer<typeof dayOutput>;
type Totals = z.infer<typeof outputSchema>["totals"];

const planTotals = (
  winners: readonly (readonly [string, RankedDayOffer])[]
): Totals => {
  let total = 0;
  let listTotal = 0;
  const byCatering = new Map<string, Totals["caterings"][number]>();
  for (const [date, o] of winners) {
    const perDay = o.price_per_day ?? 0;
    total += perDay;
    listTotal += o.price_per_day_before_promo ?? perDay;
    const prev = byCatering.get(o.company.id);
    const codes = o.promos.map((p) => p.code);
    byCatering.set(o.company.id, {
      dates: [...(prev?.dates ?? []), date],
      id: o.company.id,
      name: o.company.name ?? o.company.id,
      promo_codes: [...new Set([...(prev?.promo_codes ?? []), ...codes])],
      subtotal: round((prev?.subtotal ?? 0) + perDay),
    });
  }
  return {
    caterings: [...byCatering.values()],
    days: winners.length,
    list_total: round(listTotal),
    savings: round(listTotal - total),
    total: round(total),
  };
};

export const plan = defineTool({
  annotations: { openWorldHint: false, readOnlyHint: true },
  description:
    "Plan catering day by day, the way the dietlownik dashboard does: for " +
    "each date pick the best offer across all caterings under `sort` " +
    "(default: best fit to prefer/avoid), show its meals and why they " +
    "scored, list alternatives, and total the plan (list price → promo → " +
    "final). Mixing caterings across days is the point. Prices come from " +
    "the last scrape; run `quote` on `selections` for live numbers. For one " +
    "day's full comparison pass a single date and more `alternatives`.",
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ctx (ToolContext) embeds the DietlyClient class instance; tool only invokes its public methods
  execute: async (input, ctx) => {
    const city = await ctx.client.cities.resolve(input.city);
    const from = orderableFrom();
    const available = await getAvailableDates(city.id, "1970-01-01", 400);
    const orderable = available.filter((d) => d >= from);
    const dates = input.dates ?? orderable.slice(0, 14);
    if (dates.length === 0) {
      throw new Error(
        `No orderable dates with menus in ${city.name}. get_context lists cities with data.`
      );
    }
    const [kcalMin, kcalMax] =
      input.kcal_min <= input.kcal_max
        ? [input.kcal_min, input.kcal_max]
        : [input.kcal_max, input.kcal_min];

    // Route once, share across days (the per-day query would re-route).
    const intents = await routePreferences({
      avoid: input.avoid,
      prefer: input.prefer,
    });

    const perDay = await Promise.all(
      dates.map(async (date) => {
        if (!available.includes(date)) {
          return { considered: 0, date, offers: [] as RankedDayOffer[] };
        }
        const r = await getRankedOffersForDay({
          avoid: input.avoid,
          cityId: city.id,
          date,
          excludeCompanyIds: input.exclude,
          excludeSharedPackages: !input.include_shared_packages,
          includeCompanyIds: input.only,
          kcalMax,
          kcalMin,
          limit: 1 + input.alternatives,
          maxPerCompany: 1,
          prefer: input.prefer,
          routedIntents: intents,
          sort: input.sort,
        });
        return { considered: r.considered_count, date, offers: r.offers };
      })
    );

    const withMeals = input.detail !== "summary";
    const full = input.detail === "full";
    const winners: (readonly [string, RankedDayOffer])[] = [];
    const days: Day[] = perDay.map(
      ({ considered, date, offers }: Readonly<(typeof perDay)[number]>) => {
        const [top, ...rest] = offers;
        let note: string | null = null;
        if (!available.includes(date)) {
          note = "No menus scraped for this date.";
        } else if (top === undefined) {
          note = "Nothing matches the kcal range / catering filters that day.";
        } else if (date < from) {
          note = "Too late to order — dietly needs 2 days' lead time.";
        }
        if (top !== undefined) {
          winners.push([date, top]);
        }
        return {
          alternatives: rest.map((o) => toCard(o, { meals: false })),
          considered,
          date,
          note,
          pick:
            top === undefined ? null : toCard(top, { full, meals: withMeals }),
          weekday: weekday(date),
        };
      }
    );

    const totals = planTotals(winners);
    const multi = totals.caterings.length > 1;
    return {
      days,
      keywords: reportKeywords(
        input,
        intents,
        winners.map(([, o]) => o)
      ),
      next:
        "quote(selections) re-prices the plan live on dietly. To order: login, then " +
        `send_to_basket per catering${multi ? " — dietly's basket holds one catering at a time, so send one, check out on dietly.pl, then the next" : ""}. ` +
        "To swap a dish in a menu-choice day, call get_offer and edit that selection's picks.",
      query: {
        city: city.name,
        dates: [...dates],
        kcal: `${kcalMin}–${kcalMax}`,
        sort: input.sort,
      },
      selections: winners.map(([date, o]) => toSelection(date, o)),
      totals,
    };
  },
  inputSchema,
  name: "plan",
  outputSchema,
});
