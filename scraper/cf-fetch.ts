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
const POST_SOLVE_COOL_MS = 3_000;

const sleep = async (ms: number): Promise<void> => {
  // oxlint-disable-next-line promise/avoid-new -- low-level sleep primitive
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

const HEADLESS = process.env.CF_HEADLESS !== "0";

let ctxPromise: Promise<{
  ctx: BrowserContext;
  apiPage: Page;
}> | null = null;

// oxlint-disable-next-line typescript/promise-function-async -- caches a Promise; making it async would create an extra await wrapper per call
const getCtx = (): Promise<{
  ctx: BrowserContext;
  apiPage: Page;
}> => {
  if (ctxPromise) {
    return ctxPromise;
  }
  ctxPromise = (async () => {
    process.stderr.write(
      `[cf-fetch] launching chrome (headless=${HEADLESS}) profile=${USER_DATA_DIR}\n`
    );
    const ctx = await launchCfBrowser({ headless: HEADLESS });

    // Park a persistent page at the API origin. All fetch() calls from this
    // page are same-origin — Chrome's full network stack handles TLS, cookies,
    // and HTTP/2 exactly as a real browser would. This also warms cf_clearance
    // before the first API call goes out.
    const apiPage = await ctx.newPage();
    try {
      await apiPage.goto(`${API_ORIGIN}/`, {
        timeout: 30_000,
        waitUntil: "domcontentloaded",
      });
      await waitForChallengeCleared(apiPage, Date.now() + 30_000);
    } catch {
      // best-effort; proceed even if warm-up fails
    }
    process.stderr.write("[cf-fetch] warm-up done\n");

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

    return { ctx, apiPage };
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
  const headers = (init.headers ?? {}) as Record<string, string>;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- RequestInit.body is BodyInit; we only ever set string bodies in this codepath
  const body = (init.body as string | undefined) ?? null;

  let result: PageFetchResult;
  try {
    result = await page.evaluate(
      // oxlint-disable-next-line typescript/no-unsafe-return -- runs inside Chrome; return value is JSON-serialized by Playwright
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
          const r = await fetch(args.url, {
            method: args.method,
            headers: args.headers,
            ...(args.body !== null ? { body: args.body } : {}),
            signal: ctrl.signal,
          });
          const text = await r.text();
          const h: Record<string, string> = {};
          // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- forEach callback; Headers.forEach signature uses mutable params
          r.headers.forEach((v: string, k: string) => {
            h[k] = v;
          });
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
  const { ctx, apiPage } = await getCtx();

  let result = await rawFetch(apiPage, url, init, timeoutMs);
  if (isCloudflareChallenge(result.status, result.body)) {
    await solveChallengeViaOrigin(ctx);
    result = await rawFetch(apiPage, url, init, timeoutMs);
  }

  return new Response(result.body, {
    headers: result.headers,
    status: result.status,
  });
};
