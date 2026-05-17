import "dotenv/config";
import { query } from "../../lib/db.js";
import { getEmbedder, toPgVector } from "../../lib/embeddings.js";

const BATCH_SIZE = 16;

interface MealRow {
  readonly id: number;
  readonly fingerprint: string | null;
  readonly name: string | null;
  readonly label: string | null;
  readonly ingredients_raw: string | null;
  readonly allergens: readonly string[] | null;
}

const buildPassage = (m: MealRow): string => {
  const lines = [
    m.name ?? "",
    `Wariant: ${m.label ?? ""}`,
    `Składniki: ${m.ingredients_raw ?? ""}`,
    `Alergeny: ${(m.allergens ?? []).join(", ")}`,
  ];
  // Strip trailing empty (or "Field: " with empty value) lines.
  while (lines.length > 0) {
    const last = lines.at(-1);
    if (
      last === "" ||
      last === "Wariant: " ||
      last === "Składniki: " ||
      last === "Alergeny: "
    ) {
      lines.pop();
    } else {
      break;
    }
  }
  return lines.join("\n");
};

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
      "received SIGINT — finishing current batch, then exiting (Ctrl-C again to force)"
    );
  };
  process.on("SIGINT", onSigint);

  const rows = await query<MealRow>(
    `SELECT m.id,
            m.fingerprint,
            m.name,
            m.label,
            m.ingredients_raw,
            m.allergens
       FROM meals m
       LEFT JOIN current_meal_embeddings e ON e.meal_id = m.id
      WHERE e.meal_id IS NULL
         OR e.embedded_fp <> COALESCE(m.fingerprint, '')
      ORDER BY m.id`
  );

  if (rows.length === 0) {
    console.log("nothing to embed");
    return 0;
  }

  console.log(`embedding ${rows.length} meals in batches of ${BATCH_SIZE}…`);

  const embedder = await getEmbedder();
  let done = 0;
  let batches = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    if (terminated) {
      break;
    }
    const slice = rows.slice(i, i + BATCH_SIZE);
    const passages = slice.map(buildPassage);
    const vectors = await embedder.embedBatch(passages);

    // Inserts run sequentially per row — small batch (≤16), and we want each
    // INSERT visible to the next iteration's idempotency check on retry.
    for (let j = 0; j < slice.length; j += 1) {
      const row = slice[j];
      const vec = vectors[j];
      const fp = row.fingerprint ?? "";
      await query(
        `INSERT INTO meal_embeddings (meal_id, embedded_fp, embedding, embedded_at)
         VALUES ($1, $2, $3::vector, NOW())
         ON CONFLICT (meal_id, embedded_fp) DO NOTHING`,
        [row.id, fp, toPgVector(vec)]
      );
    }
    done += slice.length;
    batches += 1;

    const elapsedSec = (Date.now() - startedAt) / 1000;
    const rate = done / Math.max(elapsedSec, 0.001);
    console.log(
      `  batch ${batches}: ${done}/${rows.length} meals (${rate.toFixed(2)} meals/sec)`
    );
  }

  process.off("SIGINT", onSigint);

  const totalSec = (Date.now() - startedAt) / 1000;
  const throughput = done / Math.max(totalSec, 0.001);
  console.log(
    `embedded ${done} meals in ${batches} batches, took ${totalSec.toFixed(2)} seconds; throughput ${throughput.toFixed(2)} meals/sec`
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
