/**
 * bench-report: render a markdown comparison report from `bench_runs` +
 * `bench_run_per_query`. Prints to stdout; redirect into a file.
 *
 *   npm run bench:report > bench/report.md
 *   BENCH_LABELER=claude-sonnet-4-5 npm run bench:report > bench/report-sonnet45.md
 */

import "dotenv/config";
import { query } from "../../lib/db.js";

const LABELER = process.env.BENCH_LABELER ?? "claude-sonnet-4-5";

interface RunRow {
  readonly run_id: string;
  readonly model_id: string;
  readonly model_hf_id: string;
  readonly embed_dim: number;
  readonly passage_prefix: string | null;
  readonly query_prefix: string | null;
  readonly scope_city_id: string;
  readonly scope_day: string;
  readonly meal_count: number;
  readonly query_count: number;
  readonly mean_map: string;
  readonly mean_ndcg_10: string;
  readonly mean_auroc: string;
  readonly mean_recall_10: string;
  readonly mean_recall_50: string;
  readonly completed_at: string | null;
}

interface PerQueryRow {
  readonly run_id: string;
  readonly query_id: number;
  readonly query_family: string;
  readonly pool_size: number;
  readonly positives: number;
  readonly map: string;
  readonly ndcg_10: string;
  readonly auroc: string;
}

interface WinnerEntry {
  readonly model: string;
  readonly ndcg10: number;
  readonly family: string;
}

const fmt = (raw: string | null, places = 3): string => {
  if (raw === null) {
    return "—";
  }
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n.toFixed(places) : "—";
};

const sumNumbers = (xs: readonly number[]): number => {
  let s = 0;
  for (const x of xs) {
    s += x;
  }
  return s;
};

const fetchRuns = async (): Promise<RunRow[]> => {
  // Latest run per (model, scope) — re-running bench:rank for the same model
  // on the same day supersedes the old row.
  const runs = await query<RunRow>(
    `SELECT DISTINCT ON (model_id, scope_city_id, scope_day)
            run_id::text, model_id, model_hf_id, embed_dim,
            passage_prefix, query_prefix,
            scope_city_id::text, scope_day::text,
            meal_count, query_count,
            mean_map::text, mean_ndcg_10::text, mean_auroc::text,
            mean_recall_10::text, mean_recall_50::text,
            completed_at::text
       FROM bench_runs
      WHERE labeler_model = $1 AND completed_at IS NOT NULL
      ORDER BY model_id, scope_city_id, scope_day, started_at DESC`,
    [LABELER]
  );
  if (runs.length === 0) {
    console.error(`no completed runs for labeler=${LABELER}`);
    process.exit(1);
  }
  runs.sort(
    (a: Readonly<RunRow>, b: Readonly<RunRow>) =>
      Number.parseFloat(b.mean_map) - Number.parseFloat(a.mean_map)
  );
  return runs;
};

const renderHeader = (runs: readonly RunRow[]): void => {
  const scopes = [
    ...new Set(
      runs.map((r: Readonly<RunRow>) => `${r.scope_city_id}/${r.scope_day}`)
    ),
  ];

  console.log("# Embedding benchmark report");
  console.log();
  console.log(`- **Labeler:** \`${LABELER}\``);
  console.log(
    `- **Scope:** city_id=${runs[0].scope_city_id} day=${runs[0].scope_day}`
  );
  if (scopes.length > 1) {
    console.log(
      `  (multiple scopes present: ${scopes.join(", ")} — showing latest per model)`
    );
  }
  console.log(
    `- **Slice size:** ${runs[0].meal_count.toLocaleString()} meals on offer`
  );
  console.log(`- **Queries:** ${runs[0].query_count}`);
  console.log();
};

const renderAggregate = (runs: readonly RunRow[]): void => {
  console.log("## Aggregate metrics, sorted by MAP");
  console.log();
  console.log(
    "| Rank | Model | HF id | Dim | MAP | NDCG@10 | AUROC | R@10 | R@50 |"
  );
  console.log(
    "|-----:|-------|-------|----:|----:|--------:|------:|-----:|-----:|"
  );
  for (let i = 0; i < runs.length; i += 1) {
    const r = runs[i];
    console.log(
      `| ${i + 1} | \`${r.model_id}\` | \`${r.model_hf_id}\` | ${r.embed_dim} | ${fmt(r.mean_map)} | ${fmt(r.mean_ndcg_10)} | ${fmt(r.mean_auroc)} | ${fmt(r.mean_recall_10)} | ${fmt(r.mean_recall_50)} |`
    );
  }
  console.log();
};

const renderFamilyHeatmap = (
  runs: readonly RunRow[],
  perRows: readonly PerQueryRow[],
  // oxlint-disable-next-line typescript-eslint/prefer-readonly-parameter-types -- ReadonlyMap<string, string> reported as not readonly enough
  runIdToModel: ReadonlyMap<string, string>
): void => {
  const families = [
    ...new Set(perRows.map((r: Readonly<PerQueryRow>) => r.query_family)),
  ].toSorted();

  const meanByModelFamily = new Map<string, Map<string, number[]>>();
  for (const r of perRows) {
    const model = runIdToModel.get(r.run_id);
    if (model === undefined) {
      continue;
    }
    if (!meanByModelFamily.has(model)) {
      meanByModelFamily.set(model, new Map());
    }
    const bm = meanByModelFamily.get(model);
    if (bm === undefined) {
      continue;
    }
    const arr = bm.get(r.query_family) ?? [];
    arr.push(Number.parseFloat(r.ndcg_10));
    bm.set(r.query_family, arr);
  }

  console.log("## NDCG@10 per query family");
  console.log();
  console.log(`| Model | ${families.join(" | ")} |`);
  console.log(`|-------|${families.map(() => "------:").join("|")}|`);
  for (const r of runs) {
    const fam = meanByModelFamily.get(r.model_id);
    const cells = families.map((f) => {
      const arr = fam?.get(f);
      if (arr === undefined || arr.length === 0) {
        return "—";
      }
      const m = sumNumbers(arr) / arr.length;
      return m.toFixed(3);
    });
    console.log(`| \`${r.model_id}\` | ${cells.join(" | ")} |`);
  }
  console.log();
};

const renderWorstQueries = async (
  runs: readonly RunRow[],
  perRows: readonly PerQueryRow[]
): Promise<void> => {
  const topRunId = runs[0].run_id;
  const worst = perRows
    .filter((r: Readonly<PerQueryRow>) => r.run_id === topRunId)
    .toSorted(
      (a: Readonly<PerQueryRow>, b: Readonly<PerQueryRow>) =>
        Number.parseFloat(a.ndcg_10) - Number.parseFloat(b.ndcg_10)
    )
    .slice(0, 10);

  if (worst.length === 0) {
    return;
  }
  const labels = await query<{ query_id: number; query_text: string }>(
    `SELECT query_id, query_text FROM bench_queries WHERE query_id = ANY($1::int[])`,
    [worst.map((w: Readonly<PerQueryRow>) => w.query_id)]
  );
  const idToText = new Map(
    labels.map((l: Readonly<{ query_id: number; query_text: string }>) => [
      l.query_id,
      l.query_text,
    ])
  );

  console.log(
    `## Top model (\`${runs[0].model_id}\`) — worst queries by NDCG@10`
  );
  console.log();
  console.log("| Query | Family | Pool | Pos | NDCG@10 | MAP | AUROC |");
  console.log("|-------|--------|----:|----:|--------:|----:|------:|");
  for (const w of worst) {
    console.log(
      `| \`${idToText.get(w.query_id) ?? "?"}\` | ${w.query_family} | ${w.pool_size} | ${w.positives} | ${fmt(w.ndcg_10)} | ${fmt(w.map)} | ${fmt(w.auroc)} |`
    );
  }
  console.log();
};

const renderWinners = (
  perRows: readonly PerQueryRow[],
  // oxlint-disable-next-line typescript-eslint/prefer-readonly-parameter-types -- ReadonlyMap<string, string> reported as not readonly enough
  runIdToModel: ReadonlyMap<string, string>
): void => {
  const byQuery = new Map<number, WinnerEntry[]>();
  for (const r of perRows) {
    const model = runIdToModel.get(r.run_id);
    if (model === undefined) {
      continue;
    }
    const arr = byQuery.get(r.query_id) ?? [];
    arr.push({
      family: r.query_family,
      model,
      ndcg10: Number.parseFloat(r.ndcg_10),
    });
    byQuery.set(r.query_id, arr);
  }

  const winnerCounts = new Map<string, number>();
  for (const arr of byQuery.values()) {
    arr.sort(
      (a: Readonly<WinnerEntry>, b: Readonly<WinnerEntry>) =>
        b.ndcg10 - a.ndcg10
    );
    const winner = arr[0]?.model;
    if (winner !== undefined) {
      winnerCounts.set(winner, (winnerCounts.get(winner) ?? 0) + 1);
    }
  }
  console.log("## Per-query winner counts (NDCG@10)");
  console.log();
  console.log("| Model | Queries won |");
  console.log("|-------|------------:|");
  const sortedWinners = [...winnerCounts.entries()].toSorted(
    (a: readonly [string, number], b: readonly [string, number]) => b[1] - a[1]
  );
  for (const [m, n] of sortedWinners) {
    console.log(`| \`${m}\` | ${n} |`);
  }
  console.log();
};

const main = async (): Promise<void> => {
  const runs = await fetchRuns();

  renderHeader(runs);
  renderAggregate(runs);

  // ── Per-family heatmap ────────────────────────────────────────────────────
  const perRows = await query<PerQueryRow>(
    `SELECT run_id::text, query_id, query_family, pool_size, positives,
            map::text, ndcg_10::text, auroc::text
       FROM bench_run_per_query
      WHERE run_id = ANY($1::uuid[])`,
    [runs.map((r: Readonly<RunRow>) => r.run_id)]
  );

  const runIdToModel = new Map(
    runs.map((r: Readonly<RunRow>) => [r.run_id, r.model_id])
  );

  renderFamilyHeatmap(runs, perRows, runIdToModel);
  await renderWorstQueries(runs, perRows);
  renderWinners(perRows, runIdToModel);
};

try {
  await main();
  process.exit(0);
} catch (error) {
  console.error("bench-report failed:", error);
  process.exit(1);
}
