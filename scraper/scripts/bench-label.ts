/**
 * bench-label: CLI used by the Claude Code session driving the labeler loop.
 *
 * Subagents can only be dispatched from the main Claude Code session via the
 * Agent tool, not from a child process. So this script is the *contract*
 * between that session and the DB: it lets the orchestrator
 *   1. discover what needs labeling (`list-pending`),
 *   2. assemble the prompt + meal payload to hand a subagent (`fetch`),
 *   3. write the subagent's JSON labels back (`commit`).
 *
 *   npm run bench:label -- list-pending [--limit 50]
 *   npm run bench:label -- fetch <job_id>            # prints prompt + payload JSON to stdout
 *   npm run bench:label -- commit <job_id> --json '<labels-json>'
 *   npm run bench:label -- commit <job_id> --file labels.json
 *   npm run bench:label -- status [--query "<query_text>"]
 *   npm run bench:label -- reset <job_id>            # mark failed/in_progress as pending again
 */

import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { query } from "../../lib/db.js";

const dir = import.meta.dirname;
const PROMPT_PATH = join(
  dir,
  "..",
  "..",
  "bench",
  "prompts",
  "label-meal-batch.md"
);

const DEFAULT_LABELER = process.env.BENCH_LABELER_MODEL ?? "claude-sonnet-4-5";

interface PendingRow {
  job_id: string;
  query_id: number;
  query_text: string;
  query_family: string;
  batch_index: number;
  meal_count: string;
}

const listPending = async (limit: number): Promise<void> => {
  const rows = await query<PendingRow>(
    `SELECT j.job_id::text,
            j.query_id,
            q.query_text,
            q.query_family,
            j.batch_index,
            COUNT(i.meal_id)::text AS meal_count
       FROM bench_label_jobs j
       JOIN bench_queries q ON q.query_id = j.query_id
       LEFT JOIN bench_label_job_items i ON i.job_id = j.job_id
      WHERE j.status = 'pending'
      GROUP BY j.job_id, j.query_id, q.query_text, q.query_family, j.batch_index
      ORDER BY q.query_family, q.query_text, j.batch_index
      LIMIT $1`,
    [limit]
  );
  console.log(JSON.stringify(rows, null, 2));
};

interface MealPayload {
  meal_id: number;
  name: string;
  label: string | null;
  ingredients: string | null;
  allergens: string[];
  kcal: number | null;
  protein_g: number | null;
  fat_g: number | null;
  carbs_g: number | null;
  fiber_g: number | null;
  sugar_g: number | null;
  salt_g: number | null;
}

interface FetchOutput {
  job_id: number;
  query: string;
  query_family: string;
  query_notes: string | null;
  prompt: string;
  payload: {
    query: string;
    query_family: string;
    query_notes: string | null;
    meals: MealPayload[];
  };
}

const parseNum = (s: string | null): number | null =>
  s === null ? null : Number.parseFloat(s);

const fetchJob = async (jobIdRaw: string): Promise<void> => {
  const jobId = Number.parseInt(jobIdRaw, 10);
  if (!Number.isFinite(jobId)) {
    throw new TypeError(`invalid job_id: ${jobIdRaw}`);
  }

  const headers = await query<{
    query_text: string;
    query_family: string;
    notes: string | null;
  }>(
    `SELECT q.query_text, q.query_family, q.notes
       FROM bench_label_jobs j
       JOIN bench_queries q ON q.query_id = j.query_id
      WHERE j.job_id = $1`,
    [jobId]
  );
  if (headers.length === 0) {
    throw new Error(`no such job: ${jobId}`);
  }
  const [{ query_text, query_family, notes }] = headers;

  interface MealRow {
    readonly id: string;
    readonly name: string;
    readonly label: string | null;
    readonly ingredients_raw: string | null;
    readonly allergens: readonly string[] | null;
    readonly kcal: string | null;
    readonly protein_g: string | null;
    readonly fat_g: string | null;
    readonly carbs_g: string | null;
    readonly fiber_g: string | null;
    readonly sugar_g: string | null;
    readonly salt_g: string | null;
  }

  const mealRows = await query<MealRow>(
    `SELECT m.id::text, m.name, m.label, m.ingredients_raw, m.allergens,
            m.kcal::text, m.protein_g::text, m.fat_g::text, m.carbs_g::text,
            m.fiber_g::text, m.sugar_g::text, m.salt_g::text
       FROM bench_label_job_items i
       JOIN meals m ON m.id = i.meal_id
      WHERE i.job_id = $1
      ORDER BY i.meal_id`,
    [jobId]
  );

  const meals: MealPayload[] = mealRows.map(
    (m: MealRow): MealPayload => ({
      allergens: m.allergens === null ? [] : [...m.allergens],
      carbs_g: parseNum(m.carbs_g),
      fat_g: parseNum(m.fat_g),
      fiber_g: parseNum(m.fiber_g),
      ingredients: m.ingredients_raw,
      kcal: parseNum(m.kcal),
      label: m.label,
      meal_id: Number.parseInt(m.id, 10),
      name: m.name,
      protein_g: parseNum(m.protein_g),
      salt_g: parseNum(m.salt_g),
      sugar_g: parseNum(m.sugar_g),
    })
  );

  const prompt = readFileSync(PROMPT_PATH, "utf-8");
  const out: FetchOutput = {
    job_id: jobId,
    payload: {
      meals,
      query: query_text,
      query_family,
      query_notes: notes,
    },
    prompt,
    query: query_text,
    query_family,
    query_notes: notes,
  };

  // Mark in_progress so concurrent dispatch doesn't double-fetch.
  await query(
    `UPDATE bench_label_jobs
        SET status = 'in_progress', started_at = NOW(), labeler_model = $2
      WHERE job_id = $1 AND status = 'pending'`,
    [jobId, DEFAULT_LABELER]
  );

  console.log(JSON.stringify(out));
};

interface CommitLabel {
  meal_id: number;
  score: number;
  reason?: string;
}

interface CommitInput {
  labels: CommitLabel[];
}

const isCommitInput = (x: unknown): x is CommitInput =>
  typeof x === "object" &&
  x !== null &&
  Array.isArray((x as { labels?: unknown }).labels);

const commitJob = async (
  jobIdRaw: string,
  jsonText: string,
  labelerOverride?: string
): Promise<void> => {
  const jobId = Number.parseInt(jobIdRaw, 10);
  if (!Number.isFinite(jobId)) {
    throw new TypeError(`invalid job_id: ${jobIdRaw}`);
  }
  // Tolerate occasional markdown fences from the LLM.
  const cleaned = jsonText
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");

  let parsed: CommitInput;
  try {
    const raw: unknown = JSON.parse(cleaned);
    if (!isCommitInput(raw)) {
      throw new TypeError("expected { labels: [...] }");
    }
    parsed = raw;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid JSON: ${msg}`, {
      cause: error,
    });
  }

  const jobRows = await query<{
    query_id: number;
    labeler_model: string | null;
  }>(`SELECT query_id, labeler_model FROM bench_label_jobs WHERE job_id = $1`, [
    jobId,
  ]);
  if (jobRows.length === 0) {
    throw new Error(`no such job: ${jobId}`);
  }
  const queryId = jobRows[0].query_id;
  const labeler =
    labelerOverride ?? jobRows[0].labeler_model ?? DEFAULT_LABELER;

  let written = 0;
  for (const lbl of parsed.labels) {
    if (
      typeof lbl.meal_id !== "number" ||
      typeof lbl.score !== "number" ||
      lbl.score < 0 ||
      lbl.score > 10
    ) {
      throw new Error(
        `bad label entry: ${JSON.stringify(lbl)} — meal_id must be number, score 0..10`
      );
    }
    await query(
      `INSERT INTO bench_labels (query_id, meal_id, labeler_model, score, reason, job_id)
            VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (query_id, meal_id, labeler_model) DO UPDATE SET
         score      = EXCLUDED.score,
         reason     = EXCLUDED.reason,
         job_id     = EXCLUDED.job_id,
         labeled_at = NOW()`,
      [queryId, lbl.meal_id, labeler, lbl.score, lbl.reason ?? null, jobId]
    );
    written += 1;
  }

  await query(
    `UPDATE bench_label_jobs
        SET status = 'done', completed_at = NOW(), error = NULL
      WHERE job_id = $1`,
    [jobId]
  );

  console.log(
    JSON.stringify({ job_id: jobId, labeler, status: "done", written })
  );
};

const reset = async (jobIdRaw: string): Promise<void> => {
  const jobId = Number.parseInt(jobIdRaw, 10);
  await query(
    `UPDATE bench_label_jobs
        SET status = 'pending', started_at = NULL, completed_at = NULL, error = NULL
      WHERE job_id = $1`,
    [jobId]
  );
  console.log(`reset job ${jobId}`);
};

const status = async (queryFilter: string | null): Promise<void> => {
  if (queryFilter !== null) {
    const rows = await query<{
      status: string;
      n: string;
    }>(
      `SELECT j.status, COUNT(*)::text AS n
         FROM bench_label_jobs j
         JOIN bench_queries q ON q.query_id = j.query_id
        WHERE q.query_text = $1
        GROUP BY j.status`,
      [queryFilter]
    );
    console.log(
      JSON.stringify({ breakdown: rows, query: queryFilter }, null, 2)
    );
    return;
  }
  const rows = await query<{ status: string; n: string }>(
    `SELECT status, COUNT(*)::text AS n
       FROM bench_label_jobs
      GROUP BY status
      ORDER BY status`
  );
  const labeled = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM bench_labels`
  );
  console.log(
    JSON.stringify(
      { jobs_by_status: rows, total_labels: labeled[0]?.n ?? "0" },
      null,
      2
    )
  );
};

const usage = (): never => {
  console.error(
    `usage:
  bench-label list-pending [--limit N]
  bench-label fetch <job_id>
  bench-label commit <job_id> (--json '<...>' | --file <path>) [--labeler <model>]
  bench-label reset  <job_id>
  bench-label status [--query <text>]`
  );
  process.exit(2);
};

const getFlag = (args: readonly string[], flag: string): string | undefined => {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx === args.length - 1) {
    return undefined;
  }
  return args[idx + 1];
};

const main = async (): Promise<void> => {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "list-pending": {
      const limit = Number.parseInt(getFlag(rest, "--limit") ?? "50", 10);
      await listPending(limit);
      return;
    }
    case "fetch": {
      const [id] = rest;
      if (id === undefined) {
        usage();
      }
      await fetchJob(id);
      return;
    }
    case "commit": {
      const [id] = rest;
      if (id === undefined) {
        usage();
      }
      const inlineJson = getFlag(rest, "--json");
      const filePath = getFlag(rest, "--file");
      const labelerOverride = getFlag(rest, "--labeler");
      const fromFile =
        filePath !== undefined && filePath !== ""
          ? readFileSync(filePath, "utf-8")
          : undefined;
      const json = inlineJson ?? fromFile;
      if (json === undefined) {
        console.error("commit requires --json or --file");
        process.exit(2);
      }
      await commitJob(id, json, labelerOverride);
      return;
    }
    case "reset": {
      const [id] = rest;
      if (id === undefined) {
        usage();
      }
      await reset(id);
      return;
    }
    case "status": {
      const q = getFlag(rest, "--query") ?? null;
      await status(q);
      return;
    }
    default: {
      usage();
    }
  }
};

try {
  await main();
  process.exit(0);
} catch (error) {
  console.error("bench-label failed:", error);
  process.exit(1);
}
