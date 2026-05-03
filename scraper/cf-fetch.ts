// Cloudflare-resistant fetch backed by patchright + system Chrome.
//
// Why this exists: bun/node fetch keeps tripping CF's bot management at the
// scraper's burst concurrency, even with a fresh cookie + Chrome UA — the TLS
// & HTTP/2 fingerprints leak the runtime. Patchright drives a real Chrome
// (channel: 'chrome') whose fingerprints CF accepts. We expose its
// APIRequestContext as a `fetch`-compatible function so `scraper/api.ts` can
// swap transports with one line.
//
// Lifecycle: the BrowserContext is launched lazily on first call and reused
// for the rest of the process. Process exit hooks tear chrome down so child
// processes don't outlive the scraper.
//
// Cookies: chrome's persistent profile (`~/.cache/dietlownik-cf-profile`)
// keeps cookies across runs, so cf_clearance / __cf_bm stay warm between
// scrapes. Delete the dir to force a clean session.

import type { BrowserContext, APIRequestContext } from "patchright";

import {
  isCloudflareChallenge,
  launchCfBrowser,
  USER_DATA_DIR,
} from "./cf-shared";

const HEADLESS = process.env.CF_HEADLESS !== "0";

let ctxPromise: Promise<{
  ctx: BrowserContext;
  req: APIRequestContext;
}> | null = null;

async function getCtx(): Promise<{
  ctx: BrowserContext;
  req: APIRequestContext;
}> {
  if (ctxPromise) {
    return ctxPromise;
  }
  ctxPromise = (async () => {
    process.stderr.write(
      `[cf-fetch] launching chrome (headless=${HEADLESS}) profile=${USER_DATA_DIR}\n`
    );
    const ctx = await launchCfBrowser({ headless: HEADLESS });

    // Best-effort cleanup. SIGINT/SIGTERM await close so chrome dies cleanly;
    // 'exit' is sync-only — chrome will be reaped with the parent regardless.
    const close = async () => ctx.close().catch(() => {});
    process.on("exit", () => void close());
    process.on("SIGINT", () => void close().then(() => process.exit(130)));
    process.on("SIGTERM", () => void close().then(() => process.exit(143)));

    return { ctx, req: ctx.request };
  })();
  return ctxPromise;
}

// Serialize page-based challenge solves so we don't open N tabs at once
// (which would itself look bot-like to CF).
let challengeSolveLock: Promise<void> = Promise.resolve();

async function solveChallengeInPage(
  ctx: BrowserContext,
  url: string
): Promise<void> {
  const prev = challengeSolveLock;
  let release!: () => void;
  challengeSolveLock = new Promise<void>((r) => {
    release = r;
  });
  await prev;
  try {
    process.stderr.write(`[cf-fetch] CF challenge — solving in page: ${url}\n`);
    const page = await ctx.newPage();
    try {
      await page
        .goto(url, { timeout: 30_000, waitUntil: "domcontentloaded" })
        .catch(() => {});
      await page
        .waitForFunction(
          () => {
            const t = `${document.title || ""} ${(
              document.body?.textContent || ""
            ).slice(0, 200)}`;
            return !/Just a moment|Verify you are human|Checking if the site connection is secure/i.test(
              t
            );
          },
          { polling: 500, timeout: 30_000 }
        )
        .catch(() => {});
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    release();
  }
}

async function rawFetch(
  req: APIRequestContext,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<{ status: number; headers: Headers; body: string }> {
  const method = (init.method ?? "GET").toUpperCase();
  const res = await req.fetch(url, {
    data: init.body as string | undefined,
    failOnStatusCode: false,
    headers: init.headers as Record<string, string> | undefined,
    maxRedirects: 5,
    method,
    timeout: timeoutMs,
  });
  const body = await res.text();
  return { body, headers: new Headers(res.headers()), status: res.status() };
}

/**
 * `fetch`-compatible wrapper that goes through patchright + Chrome. On a CF
 * challenge response, opens the URL in a real Page so chrome's JS engine
 * solves it (sets cf_clearance in the shared cookie jar), then retries.
 */
export async function cfFetch(
  url: string,
  init: RequestInit = {},
  timeoutMs = 25_000
): Promise<Response> {
  const { ctx, req } = await getCtx();

  let result = await rawFetch(req, url, init, timeoutMs);
  if (isCloudflareChallenge(result.status, result.body)) {
    await solveChallengeInPage(ctx, url);
    result = await rawFetch(req, url, init, timeoutMs);
  }

  return new Response(result.body, {
    headers: result.headers,
    status: result.status,
  });
}
