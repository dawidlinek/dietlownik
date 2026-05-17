// Regression test for S1: the apiFetch retry loop must release its
// limiter slot before sleeping on backoff. If it doesn't, a single
// CF-challenged request holds 1-of-MAX_IN_FLIGHT slots for up to ~40s.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Tame env BEFORE importing api.ts — the module reads these at top level.
const prevEnv = { ...process.env };
process.env.DIETLY_USE_PATCHRIGHT = "0";
process.env.MAX_IN_FLIGHT = "1";
process.env.MIN_INTERVAL_MS = "0";
process.env.RETRY_MAX = "2";
process.env.RETRY_BASE_MS = "200";
process.env.REQUEST_TIMEOUT_MS = "5000";

afterAll(() => {
  process.env = prevEnv;
});

interface FetchCall {
  url: string;
  startedAt: number;
}

const sleep = async (ms: number): Promise<void> => {
  // oxlint-disable-next-line promise/avoid-new -- low-level sleep primitive in test
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- typeof fetch carries DOM Request/URL mutable types; we only read .url / .toString()
const extractUrl = (input: string | URL | Request): string => {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
};

const fetchCalls: FetchCall[] = [];
let realFetch: typeof fetch | undefined;

describe("apiFetch retry loop releases limiter slot during backoff (S1)", () => {
  // Dynamic `import("../api")` warms up scraper/cf-shared transitively on
  // first run; on Windows that import alone can take several seconds, blowing
  // through the 5s default.
  vi.setConfig({ testTimeout: 30_000 });

  beforeAll(() => {
    realFetch = globalThis.fetch;

    // Replace global fetch:
    //   /slow-503 → first call 503, then 200; the 503 triggers a backoff sleep.
    //   /fast-200 → returns 200 immediately.
    let slowCallNum = 0;
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types, typescript/promise-function-async -- typeof fetch has mutable DOM types; we always return a Promise.resolve so no async wrapper needed
    const stub: typeof fetch = (input, _init) => {
      const url = extractUrl(input);
      fetchCalls.push({ startedAt: Date.now(), url });
      if (url.includes("/slow-503")) {
        slowCallNum += 1;
        if (slowCallNum === 1) {
          return Promise.resolve(
            new Response("server busy", {
              headers: { "content-type": "text/plain" },
              status: 503,
            })
          );
        }
        return Promise.resolve(Response.json({ ok: true, source: "slow" }));
      }
      return Promise.resolve(Response.json({ ok: true, source: "fast" }));
    };
    globalThis.fetch = stub;
  });

  afterAll(() => {
    if (realFetch) {
      globalThis.fetch = realFetch;
    }
  });

  it("a backoff-sleeping request does NOT block another request from acquiring the slot", async () => {
    // Dynamic import so module-level env reads pick up our overrides.
    const api = await import("../api");

    const t0 = Date.now();
    const slowPromise = api.get<{ source: string }>("/slow-503");
    // tiny offset so we can be sure 'slow' acquired the slot first
    await sleep(10);
    const fastPromise = api.get<{ source: string }>("/fast-200");

    const [slowRes, fastRes] = await Promise.all([slowPromise, fastPromise]);

    expect(slowRes.source).toBe("slow");
    expect(fastRes.source).toBe("fast");

    // The slow request issues two HTTP attempts; we expect:
    //   call #1: /slow-503 at ~t0
    //   call #2: /fast-200 at ~t0+10ms (before the slow's 200ms backoff lapses)
    //   call #3: /slow-503 retry at ~t0+200ms
    const slowFirst = fetchCalls.find((c: Readonly<FetchCall>) =>
      c.url.includes("/slow-503")
    );
    const fastFirst = fetchCalls.find((c: Readonly<FetchCall>) =>
      c.url.includes("/fast-200")
    );
    expect(slowFirst).toBeDefined();
    expect(fastFirst).toBeDefined();
    if (!(slowFirst && fastFirst)) {
      return;
    }

    // Robust check: with the slot released, /fast-200 lands between slow's
    // first attempt and its retry in fetchCalls. With the bug (slot held),
    // /fast-200 only fires after slow's retry completes. Using positional
    // order rather than wall-clock so the test isn't timing-fragile on
    // Windows, where setTimeout granularity adds tens to hundreds of ms.
    const fastIdx = fetchCalls.findIndex((c: Readonly<FetchCall>) =>
      c.url.includes("/fast-200")
    );
    const slowRetryIdx = fetchCalls.findIndex(
      (c: Readonly<FetchCall>, i) => i > 0 && c.url.includes("/slow-503")
    );
    expect(fastIdx).toBeGreaterThan(-1);
    expect(slowRetryIdx).toBeGreaterThan(-1);
    expect(fastIdx).toBeLessThan(slowRetryIdx);

    // Sanity: total elapsed reflects the backoff for slow (>= 200ms) but
    // shouldn't be vastly more than that.
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(elapsed).toBeLessThan(5000);
  });
});
