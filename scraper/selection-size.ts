// The dashboard footer's one number: how many priced dishes the database
// has ever held — "wycenionych dań".
//
// A dish counts once per (day, catering, diet, kcal leaf, tier, city) where
// it was on the menu and that leaf had a price for that city: every option
// in a day's menu, not a product of choices — swapping a dish never changes
// the price, so combinations would overstate what is priced. Menus are
// national (v15), so one menu counts once per city it is priced in. Menus
// are fetched only for the lowest-kcal leaf of each (tier, option) family
// and fanned out to its siblings, exactly as the ranking does, so a sibling
// counts once it has a price. Re-scraping the same data leaves it
// unchanged; new days, caterings, dishes and cities grow it.
//
// Several seconds over the whole history, so it runs once per scrape and is
// stored on scrape_runs.selection_size instead of computed per page render.

import { q, withTx } from "./db";

// Each fetched day menu counts `dishes × cities`, where cities are those
// that could order a leaf of its (diet, tier, option) family at a price on
// that date. A city counts from when we first held a price for it: its own
// first quote, or — for a city that borrows its price city's quotes (v16) —
// the later of that quote and the membership's first_seen_at. Menus are
// national, so without the date cut every city tracked today would be
// credited with menus back to May that we never priced for it.
//
// Families are grouped on (diet, tier, option) and joined once, not built
// from a diet_calories self-join: the planner can't see that those columns
// are correlated, estimated the self-join at ~1% of its real size, and
// picked a nested loop — minutes instead of seconds.
//
// Prices are joined without tier_id so this runs both before and after v13.
// A family is already tier-specific, and since v13 every tier is priced, so
// a sibling priced only under another tier doesn't occur in practice.
const SELECTION_SIZE_SQL = `
  WITH day_menus AS (
    SELECT company_id, diet_calories_id, tier_id, menu_date,
           count(DISTINCT api_meal_slot_id) AS dishes
    FROM menu_items
    GROUP BY 1, 2, 3, 4
  ),
  quoted AS (
    SELECT company_id, city_id, diet_calories_id, min(first_seen_at) AS since
    FROM price_history
    GROUP BY 1, 2, 3
  ),
  priced AS (
    SELECT cc.company_id, q.diet_calories_id, cc.city_id,
           min(CASE WHEN cc.city_id = cc.price_city_id THEN q.since
                    ELSE greatest(q.since, cc.first_seen_at) END)::date AS since
    FROM quoted q
    JOIN company_cities cc
      ON cc.company_id = q.company_id AND cc.price_city_id = q.city_id
    GROUP BY 1, 2, 3
  ),
  family_cities AS (
    SELECT dc.company_id, dc.diet_id, dc.tier_id, dc.diet_option_id, p.since,
           count(*) AS cities
    FROM diet_calories dc
    JOIN priced p USING (company_id, diet_calories_id)
    WHERE dc.is_active
    GROUP BY 1, 2, 3, 4, 5
  )
  SELECT coalesce(sum(d.dishes * fc.cities), 0)::bigint AS n
  FROM day_menus d
  JOIN diet_calories dc USING (company_id, diet_calories_id, tier_id)
  JOIN family_cities fc
    ON fc.company_id     = dc.company_id
   AND fc.diet_id        = dc.diet_id
   AND fc.tier_id        = dc.tier_id
   AND fc.diet_option_id = dc.diet_option_id
   AND d.menu_date      >= fc.since`;

// Runs after the scrape's own work is done, so a regression here must not
// hold a one-shot run open: past this the run keeps its NULL and the footer
// shows the previous run's number.
const STATEMENT_TIMEOUT = "60s";

export const computeSelectionSize = async (): Promise<number> => {
  const rows = await withTx(async (tq) => {
    await tq(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
    const result = await tq<{ n: string }>(SELECTION_SIZE_SQL);
    return result.rows;
  });
  return Number(rows[0]?.n ?? 0);
};

/** Compute and store on `runId`. Best-effort: a failure is warned and swallowed. */
export const recordSelectionSize = async (runId: number): Promise<void> => {
  try {
    const n = await computeSelectionSize();
    await q(`UPDATE scrape_runs SET selection_size = $2 WHERE run_id = $1`, [
      runId,
      n,
    ]);
    console.log(`[scrape-run] selection_size = ${n}`);
  } catch (error) {
    console.warn(
      `[scrape-run] could not record selection_size: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};
