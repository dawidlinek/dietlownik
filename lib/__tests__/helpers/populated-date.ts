/**
 * Resolve dates that actually exist in `menu_items`, instead of hardcoding
 * them.
 *
 * Hardcoded fixture dates rot: the suite pinned `2026-05-17`, which aged out
 * of the retained data window and turned six passing tests into
 * `expected 0 to be greater than 0` failures that looked like regressions.
 *
 * Mirrors the pattern already used by `mcp/__tests__/rank-day.test.ts`.
 */

/** Consecutive-ish populated dates, newest first, for a city. */
export const resolvePopulatedDates = async (
  cityId: number,
  count: number
): Promise<string[]> => {
  const { q } = await import("@/scraper/db");
  const { rows } = await q<{ menu_date: string }>(
    `SELECT to_char(menu_date, 'YYYY-MM-DD') AS menu_date
     FROM menu_items mi
     WHERE mi.closed_at IS NULL
       -- Menus are national (v15); a city sees the caterings it can order from.
       AND mi.company_id IN (SELECT company_id FROM company_cities
                              WHERE city_id = $1 AND is_active)
     GROUP BY menu_date
     -- Busiest days first: a sparsely-scraped tail date would make
     -- population-dependent assertions flaky for the wrong reason.
     ORDER BY count(*) DESC, menu_date DESC
     LIMIT $2`,
    [cityId, count]
  );
  return rows
    .map((r: Readonly<{ menu_date: string }>) => r.menu_date)
    .toSorted();
};

/** Single best-populated date for a city, or null when the table is empty. */
export const resolvePopulatedDate = async (
  cityId: number
): Promise<string | null> => {
  const [date] = await resolvePopulatedDates(cityId, 1);
  return date ?? null;
};
