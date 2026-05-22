// One-time cleanup: for every catering where dietly's UI hides nutrition or
// ingredients (companies.nutrition_visible=false or ingredients_visible=false),
// strip the corresponding fields from `meals` so the dashboard stops showing
// poisoned data (e.g. the kcal=1063 leczo body across all UrbanFits dishes).
//
// What gets nulled:
//   - nutrition_visible=false  → kcal / protein_g / fat_g / carbs_g / fiber_g
//                                / sugar_g / saturated_fat_g / salt_g
//   - ingredients_visible=false→ ingredients_raw, allergens, meal_ingredients,
//                                meals_history fingerprint, meal_embeddings
//                                (the body is no longer trustworthy to embed)
//
// Run AFTER `npm run sync-form-settings` so the flags reflect dietly's truth.

import { pool, q } from "../db";

const main = async (): Promise<void> => {
  const targets = await q<{
    company_id: string;
    nutrition_visible: boolean;
    ingredients_visible: boolean;
    n_meals: string;
  }>(
    `SELECT c.company_id, c.nutrition_visible, c.ingredients_visible,
            COUNT(m.id)::text AS n_meals
       FROM companies c
       LEFT JOIN meals m ON m.company_id = c.company_id
      WHERE c.nutrition_visible = FALSE OR c.ingredients_visible = FALSE
      GROUP BY c.company_id, c.nutrition_visible, c.ingredients_visible
      ORDER BY c.company_id`
  );
  console.log(
    `cleaning ${targets.rowCount} caterings with dietly-hidden bodies:`
  );
  for (const r of targets.rows) {
    console.log(
      `  ${r.company_id.padEnd(20)} nutrition=${r.nutrition_visible}  ingredients=${r.ingredients_visible}  meals=${r.n_meals}`
    );
  }
  if (targets.rowCount === 0) {
    console.log("(nothing to do)");
    await pool.end();
    return;
  }

  // Nutrition strip — runs in one statement against all opted-out companies.
  const nutritionRes = await q(
    `UPDATE meals
        SET kcal            = NULL,
            protein_g       = NULL,
            fat_g           = NULL,
            carbs_g         = NULL,
            fiber_g         = NULL,
            sugar_g         = NULL,
            saturated_fat_g = NULL,
            salt_g          = NULL,
            updated_at      = NOW()
      WHERE company_id IN (
        SELECT company_id FROM companies WHERE nutrition_visible = FALSE
      )`
  );
  console.log(`\nnulled nutrition on ${nutritionRes.rowCount} meal rows`);

  // Ingredients strip — meals + meal_ingredients + invalidate the fingerprint
  // (so future scrapes treat this as fresh state and re-evaluate against the
  // honored visibility flags rather than no-op'ing on an old fingerprint match).
  const mealsRes = await q(
    `UPDATE meals
        SET ingredients_raw = NULL,
            allergens       = ARRAY[]::TEXT[],
            fingerprint     = NULL,
            updated_at      = NOW()
      WHERE company_id IN (
        SELECT company_id FROM companies WHERE ingredients_visible = FALSE
      )`
  );
  const ingrRes = await q(
    `DELETE FROM meal_ingredients
      WHERE meal_id IN (
        SELECT m.id FROM meals m
          JOIN companies c ON c.company_id = m.company_id
         WHERE c.ingredients_visible = FALSE
      )`
  );
  console.log(
    `nulled ingredients on ${mealsRes.rowCount} meal rows, deleted ${ingrRes.rowCount} meal_ingredients rows`
  );

  // Embeddings for these meals are now built from a name-only signal; the
  // current vector was computed against the poisoned body, so drop it. The
  // embed-meals run picks them up next pass and re-embeds against the name
  // alone (which is what dietly's own UI shows for opted-out caterings).
  const embRes = await q(
    `DELETE FROM meal_embeddings
      WHERE meal_id IN (
        SELECT m.id FROM meals m
          JOIN companies c ON c.company_id = m.company_id
         WHERE c.nutrition_visible = FALSE OR c.ingredients_visible = FALSE
      )`
  );
  console.log(`dropped ${embRes.rowCount} stale meal_embeddings rows`);

  console.log(`\n✓ cleanup done. Run \`npm run embed\` to refill embeddings.`);
  await pool.end();
};

void main().catch(async (e: unknown) => {
  console.error(e);
  await pool.end();
  process.exitCode = 1;
});
