// Run-level scrape log: scrape_runs, scrape_stage_results, scrape_errors.
//
// History needs this. A menu item that stops appearing and a catering we
// failed to scrape look identical in the data tables; the log is what tells
// them apart. Logging is best-effort — a failed log write is reported and
// swallowed, never allowed to abort the scrape it describes.

import { HttpError } from "./api";
import { q } from "./db";
import { recordSelectionSize } from "./selection-size";
import type { DeepReadonly } from "./types";

export interface RunHandle {
  id: number;
  cmd: string;
  scope: string | null;
  startedAt: Date;
}

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

const logWriteFailed = (what: string, error: unknown): void => {
  console.warn(`[scrape-run] could not record ${what}: ${errMessage(error)}`);
};

/** Persist one failure, tied to the current run when there is one. */
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
  const status = details.statusCode ?? summary.statusCode;
  const msg = details.message ?? summary.message;
  const companyId = details.companyId ?? null;
  const context = details.context ?? null;
  const tag = companyId === null ? "" : ` companyId=${companyId}`;
  const ctx = context === null ? "" : ` ctx=${context}`;
  const statusTag = status === null ? "" : ` http=${status}`;
  console.warn(
    `[scrape-error] stage=${stage}${tag}${statusTag}${ctx}: ${msg ?? "(no message)"}`
  );
  try {
    await q(
      `INSERT INTO scrape_errors (run_id, stage, company_id, context, status_code, message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [runId, stage, companyId, context, status, msg]
    );
  } catch (error) {
    logWriteFailed("scrape error", error);
  }
};

let currentRunId: number | null = null;
export const getCurrentRunId = (): number | null => currentRunId;

/**
 * Record that one stage for one company was attempted in the current run.
 * `ok` means the stage completed; `failCount` counts per-request failures
 * inside it (each also in scrape_errors). No-op outside a run.
 */
export const recordStageResult = async (
  companyId: string,
  stage: string,
  startedAt: Readonly<Date>,
  ok: boolean,
  failCount = 0
): Promise<void> => {
  const runId = currentRunId;
  if (runId === null) {
    return;
  }
  try {
    await q(
      `INSERT INTO scrape_stage_results
         (run_id, company_id, stage, started_at, finished_at, ok, fail_count)
       VALUES ($1, $2, $3, $4, NOW(), $5, $6)
       ON CONFLICT (run_id, company_id, stage) DO UPDATE SET
         finished_at = EXCLUDED.finished_at,
         ok          = EXCLUDED.ok,
         fail_count  = EXCLUDED.fail_count`,
      [runId, companyId, stage, startedAt, ok, failCount]
    );
  } catch (error) {
    logWriteFailed(`stage ${stage} for ${companyId}`, error);
  }
};

const openRun = async (
  cmd: string,
  scope: string | null
): Promise<number | null> => {
  try {
    const { rows } = await q<{ run_id: string }>(
      `INSERT INTO scrape_runs (cmd, scope) VALUES ($1, $2) RETURNING run_id`,
      [cmd, scope]
    );
    const [row] = rows;
    return row === undefined ? null : Number(row.run_id);
  } catch (error) {
    logWriteFailed("run start", error);
    return null;
  }
};

const closeRun = async (
  runId: number,
  status: "ok" | "partial" | "failed",
  ok: number | null,
  fail: number | null
): Promise<void> => {
  try {
    await q(
      `UPDATE scrape_runs
          SET finished_at = NOW(), status = $2, ok_count = $3, fail_count = $4
        WHERE run_id = $1`,
      [runId, status, ok, fail]
    );
  } catch (error) {
    logWriteFailed("run end", error);
  }
};

export const withRun = async <T>(
  cmd: string,
  scope: string | null,
  fn: (handle: DeepReadonly<RunHandle>) => Promise<{
    value: T;
    ok: number;
    fail: number;
  }>
): Promise<T> => {
  const id = await openRun(cmd, scope);
  const handle: RunHandle = {
    cmd,
    id: id ?? 0,
    scope,
    startedAt: new Date(),
  };
  currentRunId = id;
  try {
    const result = await fn(handle);
    if (id !== null) {
      await closeRun(
        id,
        result.fail > 0 ? "partial" : "ok",
        result.ok,
        result.fail
      );
      await recordSelectionSize(id);
    }
    return result.value;
  } catch (error) {
    if (id !== null) {
      await closeRun(id, "failed", null, null);
    }
    throw error;
  } finally {
    currentRunId = null;
  }
};
