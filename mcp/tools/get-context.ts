import { z } from "zod";

import { query } from "@/lib/db";
import {
  ALLERGEN_WORDS,
  CATEGORY_WORDS,
  KEYWORD_EXAMPLES,
  MACRO_WORDS,
} from "@/lib/keyword-vocab";
import { getAvailableDates, getCaterings, getKcalBounds } from "@/lib/queries";
import { orderableFrom } from "@/mcp/dates";
import { SORTS } from "@/mcp/present";
import { defineTool } from "@/mcp/tool";

// The dashboard's filter bar, as data: which city has menus, which dates can
// still be ordered, the kcal presets, the caterings you can exclude, the sort
// menu and the keyword vocabulary. An agent that skips this guesses dates
// and gets empty days back.

const inputSchema = z.object({
  city: z
    .string()
    .min(1)
    .default("Wrocław")
    .describe("Polish city name. Defaults to Wrocław, the scraped city."),
});

const outputSchema = z.object({
  caterings: z
    .array(z.string())
    .describe("`id — name`. Use the id in plan's exclude / only."),
  cities_with_data: z.array(z.string()),
  city: z.string(),
  freshness: z.object({
    menus_seen_at: z.string().nullable(),
    note: z.string(),
    prices_seen_at: z.string().nullable(),
  }),
  kcal: z.object({
    max: z.number(),
    min: z.number(),
    presets: z.array(z.number()),
  }),
  keywords: z.object({
    allergens: z.array(z.string()),
    categories: z.array(z.string()),
    examples: z.object({
      avoid: z.array(z.string()),
      prefer: z.array(z.string()),
    }),
    grammar: z.string(),
    macros: z.array(z.string()),
  }),
  orderable_dates: z.array(z.string()),
  sorts: z.record(z.string(), z.string()),
});

interface CityDataRow {
  readonly name: string;
}

interface FreshnessRow {
  readonly menus: string | null;
  readonly prices: string | null;
}

export const get_context = defineTool({
  annotations: { openWorldHint: false, readOnlyHint: true },
  description:
    "Start here. What the planner can work with: cities that have scraped " +
    "menus, the dates that can still be ordered (dietly needs 2 days' lead " +
    "time), kcal presets, caterings (ids for exclude/only), the sort options, " +
    "the keyword vocabulary for prefer/avoid, and how fresh the data is.",
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ctx (ToolContext) embeds the DietlyClient class instance; tool only invokes its public methods
  execute: async (input, ctx) => {
    const city = await ctx.client.cities.resolve(input.city);
    const [dates, bounds, caterings, cities, [fresh]] = await Promise.all([
      getAvailableDates(city.id, orderableFrom(), 30),
      getKcalBounds(city.id),
      getCaterings(city.id),
      query<CityDataRow>(
        `SELECT c.name FROM cities c
          WHERE c.tracked
            AND EXISTS (SELECT 1 FROM company_cities cc
                         WHERE cc.city_id = c.city_id AND cc.is_active
                           AND cc.price_city_id IS NOT NULL)
          ORDER BY c.name`
      ),
      query<FreshnessRow>(
        `SELECT
           (SELECT to_char(max(last_seen_at) AT TIME ZONE 'Europe/Warsaw', 'YYYY-MM-DD HH24:MI')
              FROM menu_items
             WHERE closed_at IS NULL
               AND company_id IN (SELECT company_id FROM company_cities
                                   WHERE city_id = $1 AND is_active)) AS menus,
           (SELECT to_char(max(last_seen_at) AT TIME ZONE 'Europe/Warsaw', 'YYYY-MM-DD HH24:MI')
                   || ', ' || round(100.0 * count(*) FILTER (WHERE last_seen_at > now() - interval '3 days')
                                    / NULLIF(count(*), 0)) || '% of quotes re-seen in the last 3 days'
              FROM city_quotes($1) WHERE closed_at IS NULL) AS prices`,
        [city.id]
      ),
    ]);
    return {
      caterings: caterings.map((c) => `${c.company_id} — ${c.name}`),
      cities_with_data: cities.map((c) => c.name),
      city: city.name,
      freshness: {
        menus_seen_at: fresh?.menus ?? null,
        note: "plan/find_diets use the cheapest quote seen in the last 30 days, promo included — it can be stale. `quote` re-prices live.",
        prices_seen_at: fresh?.prices ?? null,
      },
      kcal: bounds,
      keywords: {
        allergens: [...ALLERGEN_WORDS],
        categories: [...CATEGORY_WORDS],
        examples: {
          avoid: KEYWORD_EXAMPLES.avoid.map((k) => k.label),
          prefer: KEYWORD_EXAMPLES.prefer.map((k) => k.label),
        },
        grammar:
          "Free-form Polish. Allergens, macros and categories match exactly; " +
          "anything else is matched against ingredient and dish names, with a " +
          "semantic fallback. Macros: dużo|mało + białka|tłuszczu|węglowodanów|" +
          "błonnika|cukru|soli, or 'pod 500 kcal'. 'bez X' (bez glutenu, bez " +
          "mięsa) is moved to the other list. Allergens are soft penalties, " +
          "not filters — check each meal's allergens before trusting it for an allergy.",
        macros: [...MACRO_WORDS],
      },
      orderable_dates: dates,
      sorts: { ...SORTS },
    };
  },
  inputSchema,
  name: "get_context",
  outputSchema,
});
