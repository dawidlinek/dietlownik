// One-time backfill: for every catering in the DB, fetch /constant and write
// the formSettings.visibleNutritionInDietly / visibleIngredientsInDietly flags
// into companies.nutrition_visible / ingredients_visible. Run once after the
// v9 migration; future catalog scrapes keep the columns up to date automatically.

import { get } from "../api";
import { pool, q } from "../db";
import type { ConstantResponse } from "../types";

// Wrocław
const DEFAULT_CITY_ID = Number(process.env.CITY_ID ?? 986_283);

const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

const main = async (): Promise<void> => {
  const companies = await q<{ company_id: string }>(
    `SELECT company_id FROM companies ORDER BY company_id`
  );
  console.log(`syncing form settings for ${companies.rowCount} caterings...\n`);

  let touchedOff = 0;
  let touchedOn = 0;
  let errored = 0;

  for (const { company_id: companyId } of companies.rows) {
    try {
      const resp = await get<ConstantResponse>(
        `/api/mobile/open/company-card/${companyId}/constant?cityId=${DEFAULT_CITY_ID}`,
        { companyId }
      );
      const fs = resp.formSettings ?? {};
      const nutrition = fs.visibleNutritionInDietly ?? true;
      const ingredients = fs.visibleIngredientsInDietly ?? true;
      await q(
        `UPDATE companies
            SET nutrition_visible   = $2,
                ingredients_visible = $3,
                updated_at          = NOW()
          WHERE company_id = $1`,
        [companyId, nutrition, ingredients]
      );
      const off = !nutrition || !ingredients;
      if (off) {
        touchedOff += 1;
      } else {
        touchedOn += 1;
      }
      const mark = off ? "OFF" : "on ";
      console.log(
        `  [${mark}] ${companyId.padEnd(20)} nutrition=${nutrition}  ingredients=${ingredients}`
      );
    } catch (error) {
      errored += 1;
      console.warn(`  [err] ${companyId}: ${errMsg(error)}`);
    }
  }

  console.log(
    `\n✓ done. ${touchedOff} caterings opted-out, ${touchedOn} fully visible, ${errored} errored.`
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
