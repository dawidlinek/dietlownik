// One-time cleanup: for every catering where dietly's UI hides nutrition or
// ingredients (companies.nutrition_visible=false or ingredients_visible=false),
// strip the corresponding data so the dashboard stops showing poisoned data
// (e.g. the kcal=1063 leczo body across all UrbanFits dishes).
//
// What gets stripped:
//   - nutrition_visible=false  → kcal / protein_g / fat_g / carbs_g / fiber_g
//                                / sugar_g / saturated_fat_g / salt_g on every
//                                menu_items row (portions live there, not on
//                                the dish)
//   - ingredients_visible=false→ every meal_variants row with content
//                                (allergens or ingredients_raw). Its
//                                meal_ingredients and variant_embeddings
//                                cascade; menu_items.variant_id is set NULL.
//
// Embeddings are built from name + variant content, never macros, so the
// nutrition strip leaves vectors alone.
//
// Run AFTER `npm run sync-form-settings` so the flags reflect dietly's truth.

import { pool, q, withTx } from "../db";

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
  // Rows already fully NULL are skipped so the count is what actually changed.
  const nutritionRes = await q(
    `UPDATE menu_items
        SET kcal            = NULL,
            protein_g       = NULL,
            fat_g           = NULL,
            carbs_g         = NULL,
            fiber_g         = NULL,
            sugar_g         = NULL,
            saturated_fat_g = NULL,
            salt_g          = NULL
      WHERE company_id IN (
        SELECT company_id FROM companies WHERE nutrition_visible = FALSE
      )
        AND (kcal IS NOT NULL OR protein_g IS NOT NULL OR fat_g IS NOT NULL
             OR carbs_g IS NOT NULL OR fiber_g IS NOT NULL OR sugar_g IS NOT NULL
             OR saturated_fat_g IS NOT NULL OR salt_g IS NOT NULL)`
  );
  console.log(`\nnulled nutrition on ${nutritionRes.rowCount} menu_items rows`);

  // Ingredients strip — delete the variants that carry a body. Counting the
  // cascaded children first (same transaction) keeps the log as informative
  // as the old per-table deletes.
  const stripped = await withTx(async (tq) => {
    await tq(
      `CREATE TEMP TABLE hidden_variants ON COMMIT DROP AS
       SELECT v.id
         FROM meal_variants v
         JOIN meals m ON m.id = v.meal_id
         JOIN companies c ON c.company_id = m.company_id
        WHERE c.ingredients_visible = FALSE
          AND (cardinality(v.allergens) > 0 OR v.ingredients_raw IS NOT NULL)`
    );
    const counts = await tq<{ ingredients: string; embeddings: string }>(
      `SELECT
         (SELECT COUNT(*) FROM meal_ingredients
           WHERE variant_id IN (SELECT id FROM hidden_variants))::text AS ingredients,
         (SELECT COUNT(*) FROM variant_embeddings
           WHERE variant_id IN (SELECT id FROM hidden_variants))::text AS embeddings`
    );
    const del = await tq(
      `DELETE FROM meal_variants
        WHERE id IN (SELECT id FROM hidden_variants)`
    );
    return {
      embeddings: counts.rows[0]?.embeddings ?? "0",
      ingredients: counts.rows[0]?.ingredients ?? "0",
      variants: del.rowCount ?? 0,
    };
  });
  console.log(
    `deleted ${stripped.variants} meal_variants rows with a hidden body (cascaded ${stripped.ingredients} meal_ingredients, ${stripped.embeddings} variant_embeddings)`
  );

  console.log(
    `\n✓ cleanup done. The next menu scrape records name-only variants for these dishes; run \`npm run embed\` after it to embed them.`
  );
  await pool.end();
};

try {
  await main();
} catch (error) {
  console.error(error);
  await pool.end();
  process.exitCode = 1;
}
