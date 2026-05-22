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

import { cfFetch, getCfClearance } from "./cf-fetch";
import { isCloudflareChallenge, loadCfSession } from "./cf-shared";

const BASE = process.env.DIETLY_API_BASE ?? "https://aplikacja.dietly.pl";

// Default-on: route every request through patchright + Chrome (the only
// reliable way to clear CF's bot management at scraper concurrency).
// Set DIETLY_USE_PATCHRIGHT=0 to fall back to the legacy bun fetch path.
const USE_PATCHRIGHT = process.env.DIETLY_USE_PATCHRIGHT !== "0";

// Plain-fetch fast path (S3). First attempt of each request uses node/bun
// fetch with Chrome-sourced cf_clearance + UA. CF challenges flip a sticky
// window in which we revert to the patchright transport; the fast path
// resumes once the window lapses.
//
// On by default — at current rate limits (MAX_IN_FLIGHT=3, MIN_INTERVAL_MS=300)
// CF accepts the plain path at 99.9% success, and per-request latency drops
// ~25%. Set DIETLY_PLAIN_FAST_PATH=0 to force the patchright transport.
const PLAIN_FAST_PATH =
  USE_PATCHRIGHT && process.env.DIETLY_PLAIN_FAST_PATH !== "0";
const STICKY_FALLBACK_MS = Math.max(
  0,
  Number(process.env.STICKY_FALLBACK_MS ?? 30_000)
);
let stickyFallbackUntil = 0;

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

  public stats(): { inFlight: number; waiting: number; max: number } {
    return {
      inFlight: this.inFlight,
      max: this.maxInFlight,
      waiting: this.waiters.length,
    };
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

// ── verbose request logging + run summary ────────────────────────────────────
//
// Per-request logging is off by default — at ~100k requests/scrape the
// stderr volume becomes noise. Set DIETLY_LOG_REQUESTS=1 when debugging.
// Counters always accumulate; call dumpApiMetrics() at end of run for the
// single-line histogram + per-endpoint table.

const LOG_REQUESTS = process.env.DIETLY_LOG_REQUESTS === "1";

interface EndpointStats {
  count: number;
  bytes: number;
  cfChallenges: number;
  totalDurMs: number;
}

interface Metrics {
  attempts: number;
  ok: number;
  retried: number;
  cfChallenges: number;
  httpErrors: number;
  transportErrors: number;
  fastPathTried: number;
  fastPathOk: number;
  fastPathFallback: number;
  durationsMs: number[];
  bytes: number;
  byEndpoint: Map<string, EndpointStats>;
}

const metrics: Metrics = {
  attempts: 0,
  byEndpoint: new Map<string, EndpointStats>(),
  bytes: 0,
  cfChallenges: 0,
  durationsMs: [],
  fastPathFallback: 0,
  fastPathOk: 0,
  fastPathTried: 0,
  httpErrors: 0,
  ok: 0,
  retried: 0,
  transportErrors: 0,
};

// Reduce a concrete path like "/api/.../company-card/robinfood/menu/65/city/986283/date/2026-01-08"
// to a bucket like "/api/.../company-card/:slug/menu/:id/city/:id/date/:date".
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const ID_RE = /^\d+$/u;

const bucketPath = (path: string): string => {
  const [base] = path.split("?");
  const parts = base.split("/");
  let sawCompanyCard = false;
  return parts
    .map((p, _i) => {
      if (p === "") {
        return "";
      }
      if (sawCompanyCard) {
        sawCompanyCard = false;
        return ":slug";
      }
      if (p === "company-card") {
        sawCompanyCard = true;
        return p;
      }
      if (DATE_RE.test(p)) {
        return ":date";
      }
      if (ID_RE.test(p)) {
        return ":id";
      }
      return p;
    })
    .join("/");
};

const recordEndpoint = (
  method: string,
  path: string,
  durMs: number,
  bytes: number,
  cfChallenge: boolean
): void => {
  const key = `${method} ${bucketPath(path)}`;
  let row = metrics.byEndpoint.get(key);
  if (!row) {
    row = { bytes: 0, cfChallenges: 0, count: 0, totalDurMs: 0 };
    metrics.byEndpoint.set(key, row);
  }
  row.count += 1;
  row.bytes += bytes;
  row.totalDurMs += durMs;
  if (cfChallenge) {
    row.cfChallenges += 1;
  }
};

const recordDuration = (ms: number): void => {
  // cap buffer so a long scrape doesn't blow up memory
  if (metrics.durationsMs.length < 5000) {
    metrics.durationsMs.push(ms);
  }
};

const percentile = (sorted: readonly number[], p: number): number => {
  if (sorted.length === 0) {
    return 0;
  }
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx];
};

const fmtBytes = (n: number): string => {
  if (n < 1024) {
    return `${n}B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)}KB`;
  }
  if (n < 1024 * 1024 * 1024) {
    return `${(n / 1024 / 1024).toFixed(2)}MB`;
  }
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
};

export const dumpApiMetrics = (): void => {
  const sorted = metrics.durationsMs.toSorted((a, b) => a - b);
  const avg =
    sorted.length === 0
      ? 0
      : Math.round(sorted.reduce((s, v) => s + v, 0) / sorted.length);
  const p50 = Math.round(percentile(sorted, 0.5));
  const p95 = Math.round(percentile(sorted, 0.95));
  const p99 = Math.round(percentile(sorted, 0.99));
  const line = [
    "[api-summary]",
    `attempts=${metrics.attempts}`,
    `ok=${metrics.ok}`,
    `retried=${metrics.retried}`,
    `cf=${metrics.cfChallenges}`,
    `http-err=${metrics.httpErrors}`,
    `transport-err=${metrics.transportErrors}`,
    `fast-tried=${metrics.fastPathTried}`,
    `fast-ok=${metrics.fastPathOk}`,
    `fast-fallback=${metrics.fastPathFallback}`,
    `bytes=${fmtBytes(metrics.bytes)}`,
    `avg=${avg}ms`,
    `p50=${p50}ms`,
    `p95=${p95}ms`,
    `p99=${p99}ms`,
    `sample=${sorted.length}`,
  ].join(" ");
  process.stderr.write(`${line}\n`);

  // Per-endpoint breakdown, sorted by hits desc.
  const rows = [...metrics.byEndpoint.entries()].toSorted(
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- tuple [string, EndpointStats]; we only read .count
    (a: [string, EndpointStats], b: [string, EndpointStats]) =>
      b[1].count - a[1].count
  );
  process.stderr.write(
    "[api-endpoints] hits | bytes | avg-dur | cf | endpoint\n"
  );
  for (const [key, r] of rows) {
    const avgDur = r.count === 0 ? 0 : Math.round(r.totalDurMs / r.count);
    process.stderr.write(
      `[api-endpoints] ${String(r.count).padStart(5)} | ` +
        `${fmtBytes(r.bytes).padStart(8)} | ` +
        `${String(avgDur).padStart(6)}ms | ` +
        `${String(r.cfChallenges).padStart(3)} | ` +
        `${key}\n`
    );
  }
};

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

// Try a plain `fetch` first using the Chrome-sourced cf_clearance cookie + UA.
// On any CF challenge, set the sticky-fallback window and route the request
// through patchright instead. The returned Response is body-buffered so the
// caller can re-read it without worrying about an exhausted stream.
const tryFastPath = async (
  url: string,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- DOM RequestInit; we extend it
  init: RequestInit
): Promise<Response | null> => {
  metrics.fastPathTried += 1;
  const cf = await getCfClearance();
  if (cf === null) {
    metrics.fastPathFallback += 1;
    if (LOG_REQUESTS) {
      process.stderr.write(`[api] fast-path no-clearance → fallback\n`);
    }
    return null;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- init.headers is always Record<string,string> in this codepath (built by buildBaseInit)
  const baseHeaders = (init.headers ?? {}) as Record<string, string>;
  const fastInit: RequestInit = {
    ...init,
    headers: {
      ...baseHeaders,
      cookie: cf.cookieHeader,
      "user-agent": cf.userAgent,
    },
  };
  try {
    const res = await fetch(url, fastInit);
    const text = await res.text();
    if (isCloudflareChallenge(res.status, text)) {
      stickyFallbackUntil = Date.now() + STICKY_FALLBACK_MS;
      metrics.fastPathFallback += 1;
      if (LOG_REQUESTS) {
        process.stderr.write(
          `[api] fast-path CF-challenge → sticky-fallback ${STICKY_FALLBACK_MS}ms\n`
        );
      }
      // Refresh the clearance cache in the background; the actual retry
      // for this request will happen via cfFetch below.
      void (async () => {
        try {
          await getCfClearance(true);
        } catch {
          // best-effort background refresh
        }
      })();
      return null;
    }
    metrics.fastPathOk += 1;
    return new Response(text, {
      headers: res.headers,
      status: res.status,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[api] fast-path ${url} — ${msg}\n`);
    stickyFallbackUntil = Date.now() + STICKY_FALLBACK_MS;
    metrics.fastPathFallback += 1;
    return null;
  }
};

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- internal logger; mutates metrics
const logAttempt = (info: {
  method: string;
  path: string;
  attempt: number;
  transport: string;
  status: number;
  durMs: number;
  outcome: string;
  extra?: string;
}): void => {
  if (!LOG_REQUESTS) {
    return;
  }
  const { inFlight, max, waiting } = limiter.stats();
  const inflight = `${inFlight}/${max}`;
  const extra =
    info.extra !== undefined && info.extra !== "" ? ` ${info.extra}` : "";
  process.stderr.write(
    `[api] ${info.method} ${info.path} ` +
      `attempt=${info.attempt} ` +
      `transport=${info.transport} ` +
      `status=${info.status} ` +
      `dur=${info.durMs}ms ` +
      `inflight=${inflight} ` +
      `waiting=${waiting} ` +
      `outcome=${info.outcome}${extra}\n`
  );
};

// oxlint-disable-next-line eslint/complexity -- request lifecycle is inherently branchy (transport selection × retry × CF); splitting just hides the same logic
const performAttempt = async <T>(
  url: string,
  method: string,
  path: string,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- spread into a new RequestInit before use; baseInit is the DOM RequestInit type with a mutable signal
  baseInit: RequestInit,
  attempt: number,
  retry4xx: boolean
): Promise<AttemptResult<T> | AttemptRetry> => {
  metrics.attempts += 1;
  const startedAt = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    ctrl.abort();
  }, REQUEST_TIMEOUT_MS);
  const init: RequestInit = { ...baseInit, signal: ctrl.signal };
  const useFastPath = PLAIN_FAST_PATH && Date.now() >= stickyFallbackUntil;
  let transport: "fast" | "cf" | "plain" = USE_PATCHRIGHT ? "cf" : "plain";
  try {
    // Try the plain-fetch fast path first when enabled; null result means
    // either the cookie wasn't ready or CF challenged — either way fall
    // through to the patchright transport for this attempt.
    const fastRes = useFastPath ? await tryFastPath(url, init) : null;
    let res: Response;
    if (fastRes) {
      transport = "fast";
      res = fastRes;
    } else if (USE_PATCHRIGHT) {
      transport = "cf";
      res = await cfFetch(url, init, REQUEST_TIMEOUT_MS);
    } else {
      transport = "plain";
      res = await fetch(url, init);
    }
    const durMs = Date.now() - startedAt;
    recordDuration(durMs);
    // status 0 = transport-level error already logged by cf-fetch; skip silently.
    if (res.status === 0) {
      metrics.transportErrors += 1;
      logAttempt({
        attempt,
        durMs,
        method,
        outcome: "transport-error",
        path,
        status: 0,
        transport,
      });
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- transport error: no value to return
      return { done: true, value: undefined as T };
    }
    if (!res.ok) {
      let text = "";
      try {
        text = await res.text();
      } catch {
        text = "";
      }
      const cfChallenge = isCloudflareChallenge(res.status, text);
      if (cfChallenge) {
        metrics.cfChallenges += 1;
      } else {
        metrics.httpErrors += 1;
      }
      const errBytes = Buffer.byteLength(text, "utf-8");
      metrics.bytes += errBytes;
      recordEndpoint(method, path, durMs, errBytes, cfChallenge);
      const snippet = cfChallenge ? cfChallengeHint() : text;
      const err = new HttpError(method, path, res.status, snippet);
      if (
        attempt < RETRY_MAX &&
        (cfChallenge || isRetryable(res.status, retry4xx))
      ) {
        const waitMs = cfChallenge ? cfBackoffMs(attempt) : backoffMs(attempt);
        metrics.retried += 1;
        logAttempt({
          attempt,
          durMs,
          extra: `backoff=${Math.round(waitMs)}ms reason=${cfChallenge ? "cf" : "http"}`,
          method,
          outcome: "retry",
          path,
          status: res.status,
          transport,
        });
        return { done: false, err, waitMs };
      }
      logAttempt({
        attempt,
        durMs,
        method,
        outcome: cfChallenge ? "cf-fail" : "http-fail",
        path,
        status: res.status,
        transport,
      });
      throw err;
    }
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) {
      metrics.ok += 1;
      recordEndpoint(method, path, durMs, 0, false);
      logAttempt({
        attempt,
        durMs,
        method,
        outcome: "ok-non-json",
        path,
        status: res.status,
        transport,
      });
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- non-JSON response: caller asked for T but server returned nothing parseable
      return { done: true, value: undefined as T };
    }
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- res.json() returns any; caller is responsible for shape
    // Read as text first so we can measure bytes, then parse JSON.
    const text = await res.text();
    const bodyBytes = Buffer.byteLength(text, "utf-8");
    metrics.bytes += bodyBytes;
    recordEndpoint(method, path, durMs, bodyBytes, false);
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- JSON.parse returns any; caller is responsible for shape
    const json = JSON.parse(text);
    metrics.ok += 1;
    logAttempt({
      attempt,
      durMs,
      method,
      outcome: "ok",
      path,
      status: res.status,
      transport,
    });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- response shape is the caller's contract
    return { done: true, value: json as T };
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- catch param is unknown; we care about Error shape
    const e = error as Error & { name?: string };
    const durMs = Date.now() - startedAt;
    recordDuration(durMs);
    if (isAbortOrNetworkError(e) && attempt < RETRY_MAX) {
      metrics.retried += 1;
      metrics.transportErrors += 1;
      const waitMs = backoffMs(attempt);
      logAttempt({
        attempt,
        durMs,
        extra: `backoff=${Math.round(waitMs)}ms reason=net err="${e.message ?? e.name ?? "?"}"`,
        method,
        outcome: "retry",
        path,
        status: -1,
        transport,
      });
      return { done: false, err: e, waitMs };
    }
    metrics.transportErrors += 1;
    logAttempt({
      attempt,
      durMs,
      extra: `err="${e.message ?? e.name ?? "?"}"`,
      method,
      outcome: "transport-fail",
      path,
      status: -1,
      transport,
    });
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
    let result: AttemptResult<T> | AttemptRetry;
    try {
      result = await performAttempt<T>(
        url,
        method,
        path,
        baseInit,
        attempt,
        retry4xx
      );
    } finally {
      // Release the slot BEFORE the backoff sleep — otherwise a CF-challenged
      // request would hold 1-of-MAX_IN_FLIGHT slots for up to ~40s of CF
      // backoff and starve other requests.
      limiter.release();
    }
    if (result.done) {
      return result.value;
    }
    lastErr = result.err;
    await sleep(result.waitMs);
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
    .replaceAll(/\s+/gu, "")
    .replaceAll(/zł/giu, "")
    .replace(",", ".");
  const n = Number.parseFloat(cleaned.replaceAll(/[^\d.-]/gu, ""));
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
  const kcalMatch = /(\d+(?:[.,]\d+)?)\s*kcal/iu.exec(info);
  if (kcalMatch) {
    out.kcal = Number.parseFloat(kcalMatch[1].replace(",", "."));
  }
  const bMatch = /B:\s*(\d+(?:[.,]\d+)?)\s*g/iu.exec(info);
  if (bMatch) {
    out.protein_g = Number.parseFloat(bMatch[1].replace(",", "."));
  }
  const wMatch = /W:\s*(\d+(?:[.,]\d+)?)\s*g/iu.exec(info);
  if (wMatch) {
    out.carbs_g = Number.parseFloat(wMatch[1].replace(",", "."));
  }
  const tMatch = /T:\s*(\d+(?:[.,]\d+)?)\s*g/iu.exec(info);
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
  const m = /(\d+(?:[.,]\d+)?)/u.exec(val);
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
  const m = /(\d+(?:[.,]\d+)?)/u.exec(val);
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
