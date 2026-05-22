// Cloudflare-resistant fetch backed by patchright + system Chrome.
//
// Why this exists: bun/node fetch keeps tripping CF's bot management at the
// scraper's burst concurrency, even with a fresh cookie + Chrome UA — the TLS
// & HTTP/2 fingerprints leak the runtime. Patchright drives a real Chrome
// (channel: 'chrome') whose fingerprints CF accepts. We expose its
// page.evaluate fetch as a `fetch`-compatible function so `scraper/api.ts`
// can swap transports with one line.
//
// Transport: we park a persistent Page at the API origin and funnel all
// requests through page.evaluate(() => fetch(url, ...)). Same-origin fetch
// inside Chrome uses Chrome's actual TLS + cookie stack, which CF fully
// trusts. APIRequestContext.fetch() uses a separate HTTP client whose
// fingerprint CF's Bot Management detects and continuously re-challenges.
//
// Lifecycle: the BrowserContext is launched lazily on first call and reused
// for the rest of the process. Process exit hooks tear chrome down so child
// processes don't outlive the scraper.
//
// Cookies: the persistent Chrome profile (~/.cache/dietlownik-cf-profile)
// keeps cookies across runs. On first call we park a page at the API origin,
// which also refreshes cf_clearance before any API calls go out. Delete the
// profile dir to force a clean session.

import type { BrowserContext, Page } from "patchright";

import {
  isCloudflareChallenge,
  launchCfBrowser,
  waitForChallengeCleared,
  USER_DATA_DIR,
} from "./cf-shared";

const API_ORIGIN = "https://aplikacja.dietly.pl";

// Sleep after a successful solve before retrying the real request. CF's
// per-IP bot management rate counters need a moment to settle; retrying
// immediately into a burst of queued requests re-triggers the challenge.
const POST_SOLVE_COOL_MS = 3000;

const sleep = async (ms: number): Promise<void> => {
  // oxlint-disable-next-line promise/avoid-new -- low-level sleep primitive
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

const HEADLESS = process.env.CF_HEADLESS !== "0";

// Pool of parked API-origin pages. Each page.evaluate() call serializes on
// its own CDP channel; sharing a single page across concurrent requests
// makes them queue at the CDP layer. Pages share one BrowserContext (and
// so one cookie jar) so cf_clearance is global.
//
// Default 1: at MAX_IN_FLIGHT=3 + MIN_INTERVAL_MS=300 the limiter caps
// throughput long before CDP becomes the bottleneck, so a multi-page pool
// pays only its cold-start cost (+15–30s) without measurable steady-state
// gain. Bump via env when MAX_IN_FLIGHT goes up.
const PAGE_POOL_SIZE = Math.max(1, Number(process.env.CF_PAGE_POOL ?? 1));

interface CtxBundle {
  ctx: BrowserContext;
  pages: Page[];
  cursor: { i: number };
}

let ctxPromise: Promise<CtxBundle> | null = null;

// oxlint-disable-next-line typescript/promise-function-async -- caches a Promise; making it async would create an extra await wrapper per call
const getCtx = (): Promise<CtxBundle> => {
  if (ctxPromise) {
    return ctxPromise;
  }
  ctxPromise = (async () => {
    process.stderr.write(
      `[cf-fetch] launching chrome (headless=${HEADLESS}) profile=${USER_DATA_DIR} pool=${PAGE_POOL_SIZE}\n`
    );
    const ctx = await launchCfBrowser({ headless: HEADLESS });

    // Open the first page sequentially so any CF challenge is solved
    // exactly once; subsequent pages reuse the resulting cf_clearance.
    const firstPage = await ctx.newPage();
    try {
      await firstPage.goto(`${API_ORIGIN}/`, {
        timeout: 30_000,
        waitUntil: "domcontentloaded",
      });
      await waitForChallengeCleared(firstPage, Date.now() + 30_000);
    } catch {
      // best-effort; proceed even if warm-up fails
    }

    const pages: Page[] = [firstPage];
    if (PAGE_POOL_SIZE > 1) {
      const rest = await Promise.all(
        Array.from({ length: PAGE_POOL_SIZE - 1 }, async () => {
          const p = await ctx.newPage();
          try {
            await p.goto(`${API_ORIGIN}/`, {
              timeout: 30_000,
              waitUntil: "domcontentloaded",
            });
            await waitForChallengeCleared(p, Date.now() + 30_000);
          } catch {
            // best-effort; proceed even if warm-up fails
          }
          return p;
        })
      );
      pages.push(...rest);
    }
    process.stderr.write(`[cf-fetch] warm-up done (${pages.length} pages)\n`);

    // Best-effort cleanup. SIGINT/SIGTERM await close so chrome dies cleanly;
    // 'exit' is sync-only — chrome will be reaped with the parent regardless.
    const close = async (): Promise<void> => {
      try {
        await ctx.close();
      } catch {
        // best-effort cleanup
      }
    };
    process.on("exit", () => {
      void close();
    });
    process.on("SIGINT", () => {
      void (async () => {
        await close();
        process.exit(130);
      })();
    });
    process.on("SIGTERM", () => {
      void (async () => {
        await close();
        process.exit(143);
      })();
    });

    return { ctx, cursor: { i: 0 }, pages };
  })();
  return ctxPromise;
};

// Serialize page-based challenge solves so we don't open N tabs at once
// (which would itself look bot-like to CF).
let challengeSolveLock: Promise<void> = Promise.resolve();

// Navigate a temporary page to the API origin to trigger + solve CF's HTML
// interstitial, refreshing cf_clearance in the shared cookie jar. We use a
// temporary page (not apiPage) so in-flight evaluate() calls on apiPage are
// not interrupted.
const solveChallengeViaOrigin = async (
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- patchright BrowserContext is a third-party class; we call ctx.newPage() (mutates internal page list)
  ctx: BrowserContext
): Promise<void> => {
  const prev = challengeSolveLock;
  let release!: () => void;
  // oxlint-disable-next-line promise/avoid-new -- low-level synchronization waiter
  challengeSolveLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    process.stderr.write(
      `[cf-fetch] CF challenge — refreshing cf_clearance via ${API_ORIGIN}/\n`
    );
    const page = await ctx.newPage();
    try {
      try {
        await page.goto(`${API_ORIGIN}/`, {
          timeout: 30_000,
          waitUntil: "domcontentloaded",
        });
      } catch {
        // best-effort navigation
      }
      try {
        await waitForChallengeCleared(page, Date.now() + 30_000);
      } catch {
        // best-effort wait
      }
    } finally {
      try {
        await page.close();
      } catch {
        // best-effort cleanup
      }
    }
    // Let CF's per-IP bot score settle before the retry fires.
    await sleep(POST_SOLVE_COOL_MS);
  } finally {
    release();
  }
};

interface PageFetchResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

// Execute fetch() inside Chrome's JS context from the page parked at the API
// origin. Same-origin fetch uses Chrome's actual TLS + cookie stack — the
// same path CF whitelists for real browsers. Multiple concurrent calls on the
// same page are safe: each becomes an independent async task in Chrome's event
// loop.
const rawFetch = async (
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- patchright Page is a third-party class with mutating navigation methods
  page: Page,
  url: string,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- RequestInit is a DOM lib type with mutable signal/headers fields
  init: RequestInit,
  timeoutMs: number
): Promise<{ status: number; headers: Headers; body: string }> => {
  const method = (init.method ?? "GET").toUpperCase();
  // page.evaluate() args must be JSON-serializable.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- RequestInit.headers is HeadersInit; we only ever set Record<string,string> in this codepath
  const headers = (init.headers ?? {}) as Record<string, string>;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- RequestInit.body is BodyInit; we only ever set string bodies in this codepath
  const body = (init.body as string | undefined) ?? null;

  let result: PageFetchResult;
  try {
    result = await page.evaluate(
      // oxlint-disable-next-line typescript/no-unsafe-return, typescript/prefer-readonly-parameter-types -- runs inside Chrome; return value is JSON-serialized by Playwright; args is a plain bag of primitives
      async (args: {
        url: string;
        method: string;
        headers: Record<string, string>;
        body: string | null;
        timeoutMs: number;
      }): Promise<PageFetchResult> => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => {
          ctrl.abort();
        }, args.timeoutMs);
        try {
          const hasBody = args.body !== null;
          const r = await fetch(args.url, {
            ...(hasBody ? { body: args.body } : {}),
            headers: args.headers,
            method: args.method,
            signal: ctrl.signal,
          });
          const text = await r.text();
          const h: Record<string, string> = {};
          for (const [k, v] of r.headers.entries()) {
            h[k] = v;
          }
          return { body: text, headers: h, status: r.status };
        } finally {
          clearTimeout(timer);
        }
      },
      { body, headers, method, timeoutMs, url }
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[cf-fetch] ${method} ${url} — ${msg}\n`);
    // Return status 0 so callers can detect and skip without throwing.
    return { body: "", headers: new Headers(), status: 0 };
  }

  return {
    body: result.body,
    headers: new Headers(result.headers),
    status: result.status,
  };
};

/**
 * `fetch`-compatible wrapper that routes through a Chrome Page parked at the
 * API origin. On a CF challenge response, refreshes cf_clearance by navigating
 * a temporary Page to the origin (so Chrome's JS engine can solve the HTML
 * interstitial), then retries.
 */
export const cfFetch = async (
  url: string,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- RequestInit is a DOM lib type with mutable signal/headers fields
  init: RequestInit = {},
  timeoutMs = 25_000
): Promise<Response> => {
  const { ctx, pages, cursor } = await getCtx();

  // Round-robin across the page pool to spread CDP load. The upstream
  // Limiter is what bounds true concurrency seen by CF; the pool only
  // removes the CDP-serialization bottleneck inside Chrome.
  const page = pages[cursor.i % pages.length];
  cursor.i = (cursor.i + 1) % pages.length;

  let result = await rawFetch(page, url, init, timeoutMs);
  if (isCloudflareChallenge(result.status, result.body)) {
    await solveChallengeViaOrigin(ctx);
    result = await rawFetch(page, url, init, timeoutMs);
  }

  return new Response(result.body, {
    headers: result.headers,
    status: result.status,
  });
};

// ── plain-fetch fast path support (S3) ────────────────────────────────────────
//
// Read the live cf_clearance cookie + Chrome UA out of the running browser so
// `scraper/api.ts` can try a plain node/bun fetch for the common (no-CF) case
// and only fall back to the patchright transport when CF actually challenges.
// Cached for CF_COOKIE_TTL_MS to avoid hammering Chrome's CDP for every call.

const CF_COOKIE_TTL_MS = Math.max(
  1,
  Number(process.env.CF_COOKIE_TTL_MS ?? 300_000)
);

interface CfClearance {
  cookieHeader: string;
  userAgent: string;
}

let clearanceCache: { value: CfClearance; expires: number } | null = null;
let clearancePromise: Promise<CfClearance | null> | null = null;

const fetchClearance = async (): Promise<CfClearance | null> => {
  const { ctx, pages } = await getCtx();
  try {
    const cookies = await ctx.cookies(API_ORIGIN);
    const cookieHeader = cookies
      .map(
        (c: Readonly<{ name: string; value: string }>) => `${c.name}=${c.value}`
      )
      .join("; ");
    if (cookieHeader === "") {
      return null;
    }
    const userAgent = await pages[0].evaluate(() => navigator.userAgent);
    if (typeof userAgent !== "string" || userAgent === "") {
      return null;
    }
    return { cookieHeader, userAgent };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[cf-fetch] getCfClearance — ${msg}\n`);
    return null;
  }
};

/**
 * Return the current Chrome-sourced cookie header + UA for the API origin, or
 * null if the browser isn't ready or has no cookies yet. Cached for
 * CF_COOKIE_TTL_MS. Use `forceRefresh=true` after a CF challenge on the plain
 * fast path to bypass the cache.
 */
// oxlint-disable-next-line typescript/promise-function-async -- caches a Promise; making it async would create an extra await wrapper per call
export const getCfClearance = (
  forceRefresh = false
): Promise<CfClearance | null> => {
  const now = Date.now();
  if (
    !forceRefresh &&
    clearanceCache !== null &&
    clearanceCache.expires > now
  ) {
    return Promise.resolve(clearanceCache.value);
  }
  if (clearancePromise) {
    return clearancePromise;
  }
  clearancePromise = (async () => {
    try {
      const v = await fetchClearance();
      if (v) {
        clearanceCache = { expires: Date.now() + CF_COOKIE_TTL_MS, value: v };
      }
      return v;
    } finally {
      clearancePromise = null;
    }
  })();
  return clearancePromise;
};
