/**
 * bench-init: seed `bench_queries` from `bench/queries.json`.
 *
 * Idempotent. Re-running picks up edits to query_text / family / notes; will
 * NOT remove queries that were dropped from the JSON (those persist in DB so
 * historical bench_runs stay interpretable).
 *
 *   npm run bench:init
 */

import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { query } from "../../lib/db.js";

const dir = import.meta.dirname;
const QUERIES_JSON = join(dir, "..", "..", "bench", "queries.json");

interface SeedQuery {
  readonly text: string;
  readonly family: string;
  readonly expected_channel?: string;
  readonly label_source: "auto" | "llm";
  readonly notes?: string;
}

interface QueriesFile {
  readonly _meta: unknown;
  readonly queries: readonly (SeedQuery | { readonly _?: string })[];
}

const isSeed = (q: unknown): q is SeedQuery =>
  typeof q === "object" &&
  q !== null &&
  typeof (q as { text?: unknown }).text === "string";

const isQueriesFile = (x: unknown): x is QueriesFile =>
  typeof x === "object" &&
  x !== null &&
  Array.isArray((x as { queries?: unknown }).queries);

const main = async (): Promise<void> => {
  const raw = readFileSync(QUERIES_JSON, "utf-8");
  const parsedUnknown: unknown = JSON.parse(raw);
  if (!isQueriesFile(parsedUnknown)) {
    throw new Error(`malformed queries file: ${QUERIES_JSON}`);
  }
  const seeds = parsedUnknown.queries.filter(isSeed);

  console.log(`seeding ${seeds.length} queries from ${QUERIES_JSON}`);

  let inserted = 0;
  let updated = 0;
  for (const q of seeds) {
    const r = await query<{ inserted: boolean }>(
      `INSERT INTO bench_queries (query_text, query_family, expected_channel, label_source, notes)
         VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (query_text) DO UPDATE SET
         query_family     = EXCLUDED.query_family,
         expected_channel = EXCLUDED.expected_channel,
         label_source     = EXCLUDED.label_source,
         notes            = EXCLUDED.notes
       RETURNING (xmax = 0) AS inserted`,
      [
        q.text,
        q.family,
        q.expected_channel ?? null,
        q.label_source,
        q.notes ?? null,
      ]
    );
    if (r[0]?.inserted) {
      inserted += 1;
    } else {
      updated += 1;
    }
  }

  // Cheap sanity counts.
  const totals = await query<{ family: string; n: string }>(
    `SELECT query_family AS family, COUNT(*)::text AS n
       FROM bench_queries
      GROUP BY query_family
      ORDER BY query_family`
  );

  console.log(`inserted=${inserted} updated=${updated}`);
  console.log("\nper-family counts:");
  for (const row of totals) {
    console.log(`  ${row.family.padEnd(20)} ${row.n}`);
  }
};

try {
  await main();
  process.exit(0);
} catch (error) {
  console.error("bench-init failed:", error);
  process.exit(1);
}
