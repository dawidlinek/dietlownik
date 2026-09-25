import "dotenv/config";
import { query } from "../../lib/db.js";
import { embedVariants } from "../embed-queue.js";
import { PASSAGE_VERSION } from "../meal-passage.js";

// Incremental backfill: embed every meal variant that has no vector yet, or
// one from an older PASSAGE_VERSION. Safe to interrupt and re-run.
//
// Most recently served first: variants on current and upcoming menus are the
// ones ranking needs now; historical ones only matter for past dates.

// Ids handed to embedVariants per round; it batches the model calls itself.
const CHUNK = 512;

const main = async (): Promise<number> => {
  const startedAt = Date.now();

  let terminated = false;
  const onSigint = () => {
    if (terminated) {
      // Second Ctrl-C — bail immediately.
      process.exit(130);
    }
    terminated = true;
    console.log(
      "received SIGINT — finishing current chunk, then exiting (Ctrl-C again to force)"
    );
  };
  process.on("SIGINT", onSigint);

  const rows = await query<{ id: string }>(
    `SELECT v.id
       FROM meal_variants v
       LEFT JOIN variant_embeddings e ON e.variant_id = v.id
       LEFT JOIN LATERAL (
         SELECT max(mi.menu_date) AS last_served
         FROM menu_items mi WHERE mi.variant_id = v.id
       ) s ON TRUE
      WHERE e.variant_id IS NULL
         OR e.passage_version < $1
      ORDER BY s.last_served DESC NULLS LAST, v.id`,
    [PASSAGE_VERSION]
  );

  if (rows.length === 0) {
    console.log("nothing to embed");
    return 0;
  }

  console.log(`embedding ${rows.length} meal variants…`);

  let done = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    if (terminated) {
      break;
    }
    const ids = rows
      .slice(i, i + CHUNK)
      .map((r: Readonly<{ id: string }>) => Number(r.id));
    done += await embedVariants(ids);
    const elapsedSec = (Date.now() - startedAt) / 1000;
    const rate = done / Math.max(elapsedSec, 0.001);
    console.log(
      `  ${done}/${rows.length} variants (${rate.toFixed(2)} variants/sec)`
    );
  }

  process.off("SIGINT", onSigint);

  const totalSec = (Date.now() - startedAt) / 1000;
  console.log(
    `embedded ${done} variants, took ${totalSec.toFixed(2)} seconds; throughput ${(done / Math.max(totalSec, 0.001)).toFixed(2)} variants/sec`
  );

  return terminated ? 130 : 0;
};

try {
  const code = await main();
  process.exit(code);
} catch (error) {
  console.error("embed-meals failed:", error);
  process.exit(1);
}
