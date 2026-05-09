// Shared Cloudflare bits — single-source for the regex, browser launch
// config, and `.cf-session.json` payload. Imported by `api.ts` (legacy
// fetch path), `cf-fetch.ts` (patchright transport), and the two
// `scripts/cf-session*.ts` refresh helpers.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";

import { chromium } from "patchright";
import type { BrowserContext, Page } from "patchright";

// ── CF challenge detector ────────────────────────────────────────────────────

/** Body fingerprints of CF's "Just a moment..." JS interstitial. */
export const CF_CHALLENGE_RE =
  /Just a moment|cf-browser-verification|__cf_chl_/i;

export const isCloudflareChallenge = (
  status: number,
  body: string
): boolean => {
  if (status !== 403 && status !== 503 && status !== 429) {
    return false;
  }
  return CF_CHALLENGE_RE.test(body);
};

// ── .cf-session.json ─────────────────────────────────────────────────────────

export interface CfSession {
  cookie?: string;
  userAgent?: string;
  savedAt?: string;
}

export const CF_SESSION_PATH =
  process.env.DIETLY_SESSION_FILE ?? resolve(process.cwd(), ".cf-session.json");

export const loadCfSession = (): CfSession => {
  const fromEnv: CfSession = {
    cookie: process.env.DIETLY_COOKIE ?? undefined,
    userAgent: process.env.DIETLY_USER_AGENT ?? undefined,
  };
  const hasCookie = fromEnv.cookie !== undefined && fromEnv.cookie !== "";
  const hasUa = fromEnv.userAgent !== undefined && fromEnv.userAgent !== "";
  if (hasCookie || hasUa) {
    return fromEnv;
  }
  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON.parse returns any; file shape is the user's contract
    return JSON.parse(readFileSync(CF_SESSION_PATH, "utf-8")) as CfSession;
  } catch {
    return {};
  }
};

export const writeCfSession = (
  payload: Readonly<{
    cookie: string;
    userAgent: string;
  }>
): string => {
  const out = { ...payload, savedAt: new Date().toISOString() };
  writeFileSync(CF_SESSION_PATH, `${JSON.stringify(out, null, 2)}\n`, "utf-8");
  return CF_SESSION_PATH;
};

// ── Patchright + Chrome ──────────────────────────────────────────────────────

export const USER_DATA_DIR =
  process.env.CF_USER_DATA_DIR ??
  join(homedir(), ".cache", "dietlownik-cf-profile");

export const PLAYWRIGHT_BROWSERS_PATH =
  process.env.PLAYWRIGHT_BROWSERS_PATH ??
  join(homedir(), ".cache", "ms-playwright");

// Headless Chrome leaks "HeadlessChrome/…" in navigator.userAgent — CF uses
// it as a kill-signal under load. Override at context level.
export const FORCED_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

// oxlint-disable-next-line typescript/promise-function-async -- thin forwarder; adding async would force return-await dance
export const launchCfBrowser = (
  opts: Readonly<{
    headless: boolean;
  }>
): Promise<BrowserContext> => {
  mkdirSync(USER_DATA_DIR, { recursive: true });
  return chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: opts.headless,
    userAgent: opts.headless ? FORCED_UA : undefined,
    viewport: null,
  });
};

/**
 * Polls the page until CF's challenge interstitial is gone (or deadline).
 * Returns true if cleared, false on timeout.
 */
export const waitForChallengeCleared = async (
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- patchright Page is a third-party class with mutating navigation methods
  page: Page,
  deadlineAt: number
): Promise<boolean> => {
  while (Date.now() < deadlineAt) {
    let stuck = false;
    try {
      stuck = await page.evaluate(() => {
        const t = `${document.title || ""} ${(
          document.body?.textContent || ""
        ).slice(0, 200)}`;
        return /Just a moment|Verify you are human|Checking if the site connection is secure/i.test(
          t
        );
      });
    } catch {
      stuck = false;
    }
    if (!stuck) {
      return true;
    }
    await page.waitForTimeout(1000);
  }
  return false;
};
