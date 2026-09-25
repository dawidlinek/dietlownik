// Recompute the footer number now and store it on the latest finished run —
// for a fresh v14 upgrade, or after a manual data fix. The scraper does this
// itself at the end of every run.

import { pool, q } from "../db";
import { recordSelectionSize } from "../selection-size";

try {
  const { rows } = await q<{ run_id: string }>(
    `SELECT run_id FROM scrape_runs
      WHERE status IN ('ok', 'partial')
      ORDER BY finished_at DESC NULLS LAST
      LIMIT 1`
  );
  const [row] = rows;
  if (row === undefined) {
    console.error("no finished scrape run to attach selection_size to");
    process.exitCode = 1;
  } else {
    await recordSelectionSize(Number(row.run_id));
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
