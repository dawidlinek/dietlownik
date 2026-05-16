// Run-level observability. Each pipeline command (`scrape`,
// `scrape:promo-prices`, …) wraps its work in `withRun` to write a row to
// `scrape_runs` and link any `recordScrapeError` calls back to it. The
// HttpError instance carries `status` so callers can pass it through directly.

import { HttpError } from "./api";
import { q } from "./db";
import type { DeepReadonly } from "./types";

export interface RunHandle {
  id: number;
  cmd: string;
  scope: string | null;
  startedAt: Date;
}

const startRun = async (
  cmd: string,
  scope: string | null
): Promise<RunHandle> => {
  const { rows } = await q<{ id: number; started_at: Date }>(
    `INSERT INTO scrape_runs (cmd, scope) VALUES ($1, $2)
     RETURNING id, started_at`,
    [cmd, scope]
  );
  const [row] = rows;
  if (row === undefined) {
    throw new Error("scrape_runs insert returned no rows");
  }
  return { cmd, id: row.id, scope, startedAt: row.started_at };
};

const finishRun = async (
  handle: DeepReadonly<RunHandle>,
  ok: number,
  fail: number,
  fatal: string | null
): Promise<void> => {
  await q(
    `UPDATE scrape_runs
        SET finished_at = NOW(),
            ok_count    = $2,
            fail_count  = $3,
            fatal_error = $4
      WHERE id = $1`,
    [handle.id, ok, fail, fatal]
  );
};

const errMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

interface ErrorSummary {
  message: string | null;
  statusCode: number | null;
}

const summarizeError = (error: unknown): ErrorSummary => {
  if (error instanceof HttpError) {
    return { message: error.message, statusCode: error.status };
  }
  if (error === undefined) {
    return { message: null, statusCode: null };
  }
  return { message: errMessage(error), statusCode: null };
};

/**
 * Persist a single failure tied to the current run. Best-effort: a DB-side
 * failure here is itself logged but never re-raised — we don't want error
 * logging to mask the real error.
 */
export const recordScrapeError = async (
  runId: number | null,
  stage: string,
  details: Readonly<{
    companyId?: string | null;
    context?: string | null;
    statusCode?: number | null;
    message?: string | null;
    error?: unknown;
  }>
): Promise<void> => {
  const summary = summarizeError(details.error);

  try {
    await q(
      `INSERT INTO scrape_errors
         (run_id, stage, company_id, context, status_code, message)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        runId,
        stage,
        details.companyId ?? null,
        details.context ?? null,
        details.statusCode ?? summary.statusCode,
        details.message ?? summary.message,
      ]
    );
  } catch (logError) {
    console.warn(
      `[scrape-run] failed to record error: ${errMessage(logError)}`
    );
  }
};

/** Convenience for setting ambient run id; populated by withRun. */
let currentRunId: number | null = null;
export const getCurrentRunId = (): number | null => currentRunId;

export const withRun = async <T>(
  cmd: string,
  scope: string | null,
  fn: (handle: DeepReadonly<RunHandle>) => Promise<{
    value: T;
    ok: number;
    fail: number;
  }>
): Promise<T> => {
  const handle = await startRun(cmd, scope);
  currentRunId = handle.id;
  try {
    const result = await fn(handle);
    await finishRun(handle, result.ok, result.fail, null);
    return result.value;
  } catch (error) {
    await finishRun(handle, 0, 0, errMessage(error));
    throw error;
  } finally {
    currentRunId = null;
  }
};
