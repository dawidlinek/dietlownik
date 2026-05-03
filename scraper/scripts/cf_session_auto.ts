// Refresh `.cf_session.json` automatically by driving a real Chrome via
// patchright (a stealth-patched Playwright fork). The script:
//
//   1. launches patchright + system Chrome,
//   2. warms https://dietly.pl/ so any Cloudflare JS challenge runs and
//      `__cf_bm` / `cf_clearance` get set on the *.dietly.pl cookie jar,
//   3. then warms aplikacja.dietly.pl (the API host) for the same reason,
//   4. snapshots all *.dietly.pl cookies + the live `navigator.userAgent`,
//   5. smoke-tests a known-protected mobile API endpoint via bun's fetch
//      (the same runtime scraper/api.ts uses) — refuses to write a session
//      if bun can't reach the endpoint with the captured cookies + UA.
//
// Env knobs:
//   CF_HEADLESS=1            run Chrome headless (default: headed — best stealth)
//   CF_TIMEOUT_MS=120000     overall budget
//   CF_USER_DATA_DIR=...     persistent chrome profile (defaults to ~/.cache)
//   CF_KEEP_OPEN=1           leave the browser open after success (debug)
//
// Why a persistent profile: cf_clearance lasts ~30 min; reusing the profile
// means most refresh runs piggy-back on a still-warm CF cookie and finish in
// under a second.

import {
  CF_CHALLENGE_RE,
  USER_DATA_DIR,
  launchCfBrowser,
  waitForChallengeCleared,
  writeCfSession,
} from "../cf_shared";

const TIMEOUT_MS = Number(process.env.CF_TIMEOUT_MS ?? 120_000);
const HEADLESS = process.env.CF_HEADLESS === "1";
const KEEP_OPEN = process.env.CF_KEEP_OPEN === "1";

const WARM_URLS = [
  // rich HTML, runs CF JS
  "https://dietly.pl/",
  // API host CF zone
  "https://aplikacja.dietly.pl/api/mobile/open/cities/top-10",
];
const SMOKE_TEST = {
  companyId: "twojemenu",
  path: "/api/mobile/open/company-card/twojemenu/menu/14/city/986283/date/2026-05-07",
};

const log = (msg: string): void => {
  process.stderr.write(`[cf_session_auto] ${msg}\n`);
};

const errMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const smokeTestFromBun = async (
  cookie: string,
  userAgent: string
): Promise<{ status: number; body: string }> => {
  const res = await fetch(`https://aplikacja.dietly.pl${SMOKE_TEST.path}`, {
    headers: {
      accept: "application/json",
      "accept-language": "pl-PL",
      "company-id": SMOKE_TEST.companyId,
      cookie,
      "user-agent": userAgent,
      "x-launcher-type": "ANDROID_APP",
      "x-mobile-version": "4.0.0",
    },
  });
  let body = "";
  try {
    body = await res.text();
  } catch {
    body = "";
  }
  return { body, status: res.status };
};

const main = async (): Promise<void> => {
  log(`launching chrome (headless=${HEADLESS}) profile=${USER_DATA_DIR}`);
  const ctx = await launchCfBrowser({ headless: HEADLESS });

  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    const deadlineAt = Date.now() + TIMEOUT_MS;

    for (const url of WARM_URLS) {
      log(`warm: ${url}`);
      try {
        await page.goto(url, {
          timeout: 30_000,
          waitUntil: "domcontentloaded",
        });
      } catch (error) {
        log(`  (nav: ${errMessage(error).split("\n")[0]} — continuing)`);
      }
      const cleared = await waitForChallengeCleared(page, deadlineAt);
      if (!cleared) {
        log("  (CF challenge did not clear within budget — continuing)");
      }
      // CF / site JS often sets cookies after DCL.
      await page.waitForTimeout(1500);
    }

    const allCookies = await ctx.cookies();
    const cookies = allCookies.filter(
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- patchright Cookie is a third-party type with no readonly variant
      (c) => c.domain.endsWith("dietly.pl")
    );
    if (cookies.length === 0) {
      throw new Error(
        "no *.dietly.pl cookies captured — chrome session is empty"
      );
    }
    const cookieStr = cookies
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- patchright Cookie is a third-party type with no readonly variant
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
    const userAgent = await page.evaluate(() => navigator.userAgent);
    log(
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- patchright Cookie is a third-party type with no readonly variant
      `captured ${cookies.length} cookies: ${cookies.map((c) => c.name).join(", ")}`
    );

    log(`smoke test from bun: GET ${SMOKE_TEST.path}`);
    const smoke = await smokeTestFromBun(cookieStr, userAgent);
    log(`  → status=${smoke.status}`);
    if (smoke.status === 403 && CF_CHALLENGE_RE.test(smoke.body)) {
      throw new Error(
        "bun fetch was CF-challenged — captured cookies do not satisfy CF for this client"
      );
    }
    if (smoke.status >= 500) {
      throw new Error(`smoke test 5xx: ${smoke.body.slice(0, 200)}`);
    }

    const path = writeCfSession({ cookie: cookieStr, userAgent });
    log(`wrote ${path}`);
    log(`  user-agent: ${userAgent}`);
    if (smoke.status !== 200) {
      log(
        `  note: smoke test returned ${smoke.status} (CF passed; app body: ${smoke.body.slice(0, 120)})`
      );
    }
  } finally {
    if (KEEP_OPEN) {
      log("CF_KEEP_OPEN=1 — leaving browser open; ctrl-c to exit");
    } else {
      await ctx.close();
    }
  }
};

// oxlint-disable-next-line promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- top-level entry point
main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
