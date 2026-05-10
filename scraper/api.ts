// HTTP client for the dietly.pl mobile API (aplikacja.dietly.pl).
//
// Adds a global token-bucket rate limiter and exponential-backoff retry on
// transient failures. Every /company-card/{slug}/... call must include the
// `company-id` request header — without it the mobile API returns 400.
//
// Cloudflare bypass: the host is fronted by CF, which challenges bun/node
// fetch under any meaningful concurrency (TLS fingerprint leak). By default
// we route every call through `cf-fetch.ts`, which drives a real Chrome via
// patchright (`channel: 'chrome'`); chrome's fingerprints clear CF, and a
// page-based fallback solves the JS challenge whenever it does fire.
//
// Set `DIETLY_USE_PATCHRIGHT=0` to fall back to bun fetch — in that mode
// you'll need a fresh `.cf-session.json` (cookie + UA) at the repo root.
// `scraper/scripts/cf-session.ts` parses a "Copy as cURL" string and writes
// it for you; `cf-session-auto.ts` does the same headlessly via patchright.

import { cfFetch } from "./cf-fetch";
import { isCloudflareChallenge, loadCfSession } from "./cf-shared";

const BASE = process.env.DIETLY_API_BASE ?? "https://aplikacja.dietly.pl";

// Default-on: route every request through patchright + Chrome (the only
// reliable way to clear CF's bot management at scraper concurrency).
// Set DIETLY_USE_PATCHRIGHT=0 to fall back to the legacy bun fetch path.
const USE_PATCHRIGHT = process.env.DIETLY_USE_PATCHRIGHT !== "0";

// Tunables. With USE_PATCHRIGHT (the default), all requests funnel through a
// single Chrome instance. CF's Bot Management triggers on burst rate, not just
// fingerprint — keep concurrency low and add a minimum inter-request gap so
// the per-IP request rate stays below CF's automated-traffic threshold.
// Without patchright, the previous values (32 / 0) hold.
const MAX_IN_FLIGHT = Number(
  process.env.MAX_IN_FLIGHT ?? (USE_PATCHRIGHT ? 3 : 32)
);
const MIN_INTERVAL_MS = Number(
  process.env.MIN_INTERVAL_MS ?? (USE_PATCHRIGHT ? 300 : 0)
);
const RETRY_MAX = Number(process.env.RETRY_MAX ?? 3);
const RETRY_BASE_MS = Number(process.env.RETRY_BASE_MS ?? 500);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 25_000);

interface FetchOptions extends Omit<RequestInit, "headers" | "body"> {
  companyId?: string;
  headers?: Readonly<Record<string, string>>;
  body?: unknown;
  /** Skip retries on 4xx (default true) — set false to retry 4xx too. */
  retry4xx?: boolean;
}

export const sleep = async (ms: number): Promise<void> => {
  // oxlint-disable-next-line promise/avoid-new -- low-level sleep primitive
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

// ── In-flight semaphore + min-interval pacer ─────────────────────────────────
//
// Two independent limits:
//   1. `inFlight` — at most MAX_IN_FLIGHT concurrent fetches.
//   2. `nextSlot` — global earliest "next request start" timestamp; ensures at
//      least MIN_INTERVAL_MS between request starts. 0 disables the pacer.
//
// Both are simple, deterministic, and (unlike the previous token-bucket
// implementation) don't have wake-loop bugs at high concurrency.

class Limiter {
  private inFlight = 0;
  private readonly waiters: (() => void)[] = [];
  private nextSlot = 0;
  private readonly maxInFlight: number;
  private readonly minIntervalMs: number;

  public constructor(maxInFlight: number, minIntervalMs: number) {
    this.maxInFlight = maxInFlight;
    this.minIntervalMs = minIntervalMs;
  }

  public async acquire(): Promise<void> {
    while (this.inFlight >= this.maxInFlight) {
      // oxlint-disable-next-line promise/avoid-new -- low-level synchronization waiter
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
      });
    }
    this.inFlight += 1;

    if (this.minIntervalMs > 0) {
      const now = Date.now();
      const wait = Math.max(0, this.nextSlot - now);
      this.nextSlot = Math.max(now, this.nextSlot) + this.minIntervalMs;
      if (wait > 0) {
        await sleep(wait);
      }
    }
  }

  public release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const w = this.waiters.shift();
    if (w !== undefined) {
      w();
    }
  }
}

const limiter = new Limiter(MAX_IN_FLIGHT, MIN_INTERVAL_MS);

// `.cf-session.json` cookie/UA — only used by the legacy bun-fetch path
// (USE_PATCHRIGHT=0). Patchright manages its own cookie jar.
const cfSession = loadCfSession();

// Exposed for tests.
export const newLimiterForTests = (
  maxInFlight: number,
  minIntervalMs: number
): Limiter => new Limiter(maxInFlight, minIntervalMs);

export type { Limiter };

// oxlint-disable-next-line max-classes-per-file -- HttpError + Limiter are tightly coupled to apiFetch; keep colocated
export class HttpError extends Error {
  public method: string;
  public path: string;
  public status: number;
  public bodySnippet: string;

  public constructor(
    method: string,
    path: string,
    status: number,
    bodySnippet: string
  ) {
    super(`${method} ${path} → ${status}: ${bodySnippet.slice(0, 300)}`);
    this.name = "HttpError";
    this.method = method;
    this.path = path;
    this.status = status;
    this.bodySnippet = bodySnippet;
  }
}

// ── retry helpers ─────────────────────────────────────────────────────────────

const isRetryable = (status: number, retry4xx: boolean): boolean => {
  if (status >= 500) {
    return true;
  }
  if (status === 429) {
    return true;
  }
  if (retry4xx && status >= 400 && status < 500) {
    return true;
  }
  return false;
};

const backoffMs = (attempt: number): number => {
  const base = RETRY_BASE_MS * 2 ** (attempt - 1);
  // up to +50% jitter
  return base + Math.random() * base * 0.5;
};

/** Cloudflare challenge: long, jittered backoffs because CF needs idle time. */
const cfBackoffMs = (attempt: number): number => {
  // 5s, 10s, 20s, 40s
  const base = 5000 * 2 ** (attempt - 1);
  return base + Math.random() * base * 0.5;
};

const cfChallengeHint = (): string => {
  if (USE_PATCHRIGHT) {
    return "[cloudflare-challenge: chrome was rate-limited — lower MAX_IN_FLIGHT or set MIN_INTERVAL_MS]";
  }
  if (cfSession.cookie !== undefined && cfSession.cookie !== "") {
    return "[cloudflare-challenge: session expired — refresh via `bun scraper/scripts/cf-session.ts`]";
  }
  return "[cloudflare-challenge: no DIETLY_COOKIE / .cf-session.json — see scraper/api.ts header]";
};

// ── core fetcher ──────────────────────────────────────────────────────────────

const buildBaseInit = (
  method: string,
  companyId: string | undefined,
  body: unknown,
  headers: Readonly<Record<string, string>>,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- RequestInit (DOM lib) carries a mutable AbortSignal; we forward into another RequestInit
  rest: Omit<RequestInit, "headers" | "body" | "method">
): RequestInit => {
  const hasBody = body !== undefined;
  const useLegacyUa =
    !USE_PATCHRIGHT &&
    cfSession.userAgent !== undefined &&
    cfSession.userAgent !== "";
  const useLegacyCookie =
    !USE_PATCHRIGHT &&
    cfSession.cookie !== undefined &&
    cfSession.cookie !== "";
  const hasCompanyId = companyId !== undefined && companyId !== "";

  return {
    ...rest,
    headers: {
      accept: "application/json",
      "accept-language": "pl-PL",
      "x-launcher-type": "ANDROID_APP",
      "x-mobile-version": "4.0.0",
      // Patchright drives a real chrome that manages its own cookie jar +
      // sends a real chrome UA — overriding either confuses CF.
      ...(useLegacyUa ? { "user-agent": cfSession.userAgent } : {}),
      ...(useLegacyCookie ? { cookie: cfSession.cookie } : {}),
      ...(hasCompanyId ? { "company-id": companyId } : {}),
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    method,
    ...(hasBody
      ? { body: typeof body === "string" ? body : JSON.stringify(body) }
      : {}),
  };
};

interface AttemptResult<T> {
  done: true;
  value: T;
}

interface AttemptRetry {
  done: false;
  err: Error;
  waitMs: number;
}

const isAbortOrNetworkError = (
  e: Readonly<Error & { name?: string }>
): boolean => {
  if (e.name === "AbortError") {
    return true;
  }
  const msg = e.message;
  if (msg === undefined || msg === "") {
    return false;
  }
  return msg.includes("fetch failed") || msg.includes("ECONN");
};

const performAttempt = async <T>(
  url: string,
  method: string,
  path: string,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- spread into a new RequestInit before use; baseInit is the DOM RequestInit type with a mutable signal
  baseInit: RequestInit,
  attempt: number,
  retry4xx: boolean
): Promise<AttemptResult<T> | AttemptRetry> => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    ctrl.abort();
  }, REQUEST_TIMEOUT_MS);
  const init: RequestInit = { ...baseInit, signal: ctrl.signal };
  try {
    const res = USE_PATCHRIGHT
      ? await cfFetch(url, init, REQUEST_TIMEOUT_MS)
      : await fetch(url, init);
    if (!res.ok) {
      let text = "";
      try {
        text = await res.text();
      } catch {
        text = "";
      }
      const cfChallenge = isCloudflareChallenge(res.status, text);
      const snippet = cfChallenge ? cfChallengeHint() : text;
      const err = new HttpError(method, path, res.status, snippet);
      if (
        attempt < RETRY_MAX &&
        (cfChallenge || isRetryable(res.status, retry4xx))
      ) {
        const waitMs = cfChallenge ? cfBackoffMs(attempt) : backoffMs(attempt);
        return { done: false, err, waitMs };
      }
      throw err;
    }
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- non-JSON response: caller asked for T but server returned nothing parseable
      return { done: true, value: undefined as T };
    }
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- res.json() returns any; caller is responsible for shape
    const json = await res.json();
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- response shape is the caller's contract
    return { done: true, value: json as T };
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- catch param is unknown; we care about Error shape
    const e = error as Error & { name?: string };
    if (isAbortOrNetworkError(e) && attempt < RETRY_MAX) {
      return { done: false, err: e, waitMs: backoffMs(attempt) };
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

const apiFetch = async <T>(
  path: string,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- FetchOptions extends DOM RequestInit which carries mutable AbortSignal/headers
  options: FetchOptions = {}
): Promise<T> => {
  const { companyId, headers = {}, body, retry4xx = false, ...rest } = options;
  const method = (rest.method ?? "GET").toUpperCase();
  const url = `${BASE}${path}`;

  // Static across retry attempts; only `signal` is per-attempt.
  const baseInit = buildBaseInit(method, companyId, body, headers, rest);

  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= RETRY_MAX; attempt += 1) {
    await limiter.acquire();
    try {
      const result = await performAttempt<T>(
        url,
        method,
        path,
        baseInit,
        attempt,
        retry4xx
      );
      if (result.done) {
        return result.value;
      }
      lastErr = result.err;
      await sleep(result.waitMs);
    } finally {
      limiter.release();
    }
  }
  throw (
    lastErr ??
    new Error(`apiFetch fell through without result: ${method} ${path}`)
  );
};

// ── public api ───────────────────────────────────────────────────────────────

// oxlint-disable-next-line typescript/promise-function-async -- thin forwarder; adding async would force return-await dance
export const get = <T>(
  path: string,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- FetchOptions extends DOM RequestInit (mutable AbortSignal/headers)
  options: FetchOptions = {}
): Promise<T> => apiFetch<T>(path, options);

// oxlint-disable-next-line typescript/promise-function-async -- thin forwarder; adding async would force return-await dance
export const post = <T>(
  path: string,
  body: unknown,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- FetchOptions extends DOM RequestInit (mutable AbortSignal/headers)
  options: FetchOptions = {}
): Promise<T> => apiFetch<T>(path, { ...options, body, method: "POST" });

// ── pure utilities ───────────────────────────────────────────────────────────

export const parsePrice = (val?: string | number | null): number | null => {
  if (val == null) {
    return null;
  }
  if (typeof val === "number") {
    return val;
  }
  // Polish format may use comma as decimal: "1 234,50 zł" → 1234.50
  const cleaned = val
    .replaceAll(/\s+/g, "")
    .replaceAll(/zł/gi, "")
    .replace(",", ".");
  const n = Number.parseFloat(cleaned.replaceAll(/[^\d.-]/g, ""));
  return Number.isNaN(n) ? null : n;
};

/**
 * Parse the per-meal "info" string returned by the menu endpoint.
 * Format: "300 kcal • B:19g • W:30g • T:11g"
 *   B = Białka (protein), W = Węglowodany (carbs), T = Tłuszcze (fat)
 */
export const parseInfoMacros = (
  info: string | null | undefined
): {
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
} => {
  const out = {
    carbs_g: null as number | null,
    fat_g: null as number | null,
    kcal: null as number | null,
    protein_g: null as number | null,
  };
  if (info === null || info === undefined || info === "") {
    return out;
  }
  const kcalMatch = /(\d+(?:[.,]\d+)?)\s*kcal/i.exec(info);
  if (kcalMatch) {
    out.kcal = Number.parseFloat(kcalMatch[1].replace(",", "."));
  }
  const bMatch = /B:\s*(\d+(?:[.,]\d+)?)\s*g/i.exec(info);
  if (bMatch) {
    out.protein_g = Number.parseFloat(bMatch[1].replace(",", "."));
  }
  const wMatch = /W:\s*(\d+(?:[.,]\d+)?)\s*g/i.exec(info);
  if (wMatch) {
    out.carbs_g = Number.parseFloat(wMatch[1].replace(",", "."));
  }
  const tMatch = /T:\s*(\d+(?:[.,]\d+)?)\s*g/i.exec(info);
  if (tMatch) {
    out.fat_g = Number.parseFloat(tMatch[1].replace(",", "."));
  }
  return out;
};

/** Parse strings like "300.45 kcal / 1257 kJ" to a number. */
export const parseKcalNumber = (
  val?: string | number | null
): number | null => {
  if (val == null) {
    return null;
  }
  if (typeof val === "number") {
    return val;
  }
  const m = /(\d+(?:[.,]\d+)?)/.exec(val);
  return m ? Number.parseFloat(m[1].replace(",", ".")) : null;
};

/** Parse strings like "18.87g" → 18.87. */
export const parseGrams = (val?: string | number | null): number | null => {
  if (val == null) {
    return null;
  }
  if (typeof val === "number") {
    return val;
  }
  const m = /(\d+(?:[.,]\d+)?)/.exec(val);
  return m ? Number.parseFloat(m[1].replace(",", ".")) : null;
};

export const futureWeekdays = (
  count: number,
  {
    includeSaturday = false,
    includeSunday = false,
    fromDaysOffset = 1,
  }: Readonly<{
    includeSaturday?: boolean;
    includeSunday?: boolean;
    fromDaysOffset?: number;
  }> = {}
): string[] => {
  const dates: string[] = [];
  const d = new Date();
  d.setDate(d.getDate() + fromDaysOffset);
  while (dates.length < count) {
    // 0 = Sun, 6 = Sat
    const day = d.getDay();
    const skip =
      (day === 0 && !includeSunday) || (day === 6 && !includeSaturday);
    if (!skip) {
      dates.push(d.toISOString().slice(0, 10));
    }
    d.setDate(d.getDate() + 1);
  }
  return dates;
};

/** Inclusive range of N future calendar dates (no weekend filtering). */
export const nextNDates = (count: number, fromDaysOffset = 0): string[] => {
  const out: string[] = [];
  const d = new Date();
  d.setDate(d.getDate() + fromDaysOffset);
  for (let i = 0; i < count; i += 1) {
    out.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return out;
};
