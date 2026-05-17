// Run-level observability — graceful no-op shim for the new schema.
//
// The new schema (per the upstream rewrite plan) intentionally drops
// `scrape_runs` and `scrape_errors`: ops/observability is out of scope and
// can be reintroduced as an additive migration if drift debugging needs
// them. To keep call sites (index.ts, prices.ts) working without churn,
// `withRun` and `recordScrapeError` are kept as no-ops that synthesise
// the same return shapes.

import { HttpError } from "./api";
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

/**
 * Persist a single failure tied to the current run. With the new schema this
 * is a console-only sink — errors are logged but not stored. Existing call
 * sites pass through unchanged.
 */
// oxlint-disable-next-line typescript/require-await -- API shape preserved (async) for call-site compatibility
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
  const tag =
    details.companyId !== undefined && details.companyId !== null
      ? ` companyId=${details.companyId}`
      : "";
  const ctx =
    details.context !== undefined && details.context !== null
      ? ` ctx=${details.context}`
      : "";
  const statusTag =
    status !== null && status !== undefined ? ` http=${status}` : "";
  void runId;
  console.warn(
    `[scrape-error] stage=${stage}${tag}${statusTag}${ctx}: ${msg ?? "(no message)"}`
  );
};

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
  const handle: RunHandle = {
    cmd,
    id: 0,
    scope,
    startedAt: new Date(),
  };
  currentRunId = handle.id;
  try {
    const result = await fn(handle);
    return result.value;
  } finally {
    currentRunId = null;
  }
};
