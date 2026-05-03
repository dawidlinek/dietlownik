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

import { cfFetch } from './cf-fetch.js';
import { isCloudflareChallenge, loadCfSession } from './cf-shared.js';

const BASE = process.env.DIETLY_API_BASE ?? 'https://aplikacja.dietly.pl';

// Default-on: route every request through patchright + Chrome (the only
// reliable way to clear CF's bot management at scraper concurrency).
// Set DIETLY_USE_PATCHRIGHT=0 to fall back to the legacy bun fetch path.
const USE_PATCHRIGHT = process.env.DIETLY_USE_PATCHRIGHT !== '0';

// Tunables. With USE_PATCHRIGHT (the default), all requests funnel through a
// single Chrome instance — keep concurrency modest so we don't trip CF's
// bot-management rate threshold. Without patchright, the previous values
// (32 / 0) hold; raise via env if running on a private API server.
const MAX_IN_FLIGHT      = Number(process.env.MAX_IN_FLIGHT      ?? (USE_PATCHRIGHT ? 6 : 32));
const MIN_INTERVAL_MS    = Number(process.env.MIN_INTERVAL_MS    ?? 0);
const RETRY_MAX          = Number(process.env.RETRY_MAX          ?? 3);
const RETRY_BASE_MS      = Number(process.env.RETRY_BASE_MS      ?? 500);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 25000);

interface FetchOptions extends Omit<RequestInit, 'headers' | 'body'> {
  companyId?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Skip retries on 4xx (default true) — set false to retry 4xx too. */
  retry4xx?: boolean;
}

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
  private waiters: Array<() => void> = [];
  private nextSlot = 0;

  constructor(private maxInFlight: number, private minIntervalMs: number) {}

  async acquire(): Promise<void> {
    while (this.inFlight >= this.maxInFlight) {
      await new Promise<void>(resolve => this.waiters.push(resolve));
    }
    this.inFlight += 1;

    if (this.minIntervalMs > 0) {
      const now = Date.now();
      const wait = Math.max(0, this.nextSlot - now);
      this.nextSlot = Math.max(now, this.nextSlot) + this.minIntervalMs;
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
    }
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const w = this.waiters.shift();
    if (w) w();
  }

  get stats() {
    return { inFlight: this.inFlight, waiting: this.waiters.length };
  }
}

const limiter = new Limiter(MAX_IN_FLIGHT, MIN_INTERVAL_MS);

// `.cf-session.json` cookie/UA — only used by the legacy bun-fetch path
// (USE_PATCHRIGHT=0). Patchright manages its own cookie jar.
const cfSession = loadCfSession();

// Exposed for tests.
export function _newLimiterForTests(maxInFlight: number, minIntervalMs: number): Limiter {
  return new Limiter(maxInFlight, minIntervalMs);
}
export type { Limiter };

// ── retry helpers ─────────────────────────────────────────────────────────────

function isRetryable(status: number, retry4xx: boolean): boolean {
  if (status >= 500) return true;
  if (status === 429) return true;
  if (retry4xx && status >= 400 && status < 500) return true;
  return false;
}

function backoffMs(attempt: number): number {
  const base = RETRY_BASE_MS * 2 ** (attempt - 1);
  return base + Math.random() * base * 0.5; // up to +50% jitter
}

/** Cloudflare challenge: long, jittered backoffs because CF needs idle time. */
function cfBackoffMs(attempt: number): number {
  const base = 5000 * 2 ** (attempt - 1);   // 5s, 10s, 20s, 40s
  return base + Math.random() * base * 0.5;
}

function cfChallengeHint(): string {
  if (USE_PATCHRIGHT) return '[cloudflare-challenge: chrome was rate-limited — lower MAX_IN_FLIGHT or set MIN_INTERVAL_MS]';
  if (cfSession.cookie) return '[cloudflare-challenge: session expired — refresh via `bun scraper/scripts/cf-session.ts`]';
  return '[cloudflare-challenge: no DIETLY_COOKIE / .cf-session.json — see scraper/api.ts header]';
}

// ── core fetcher ──────────────────────────────────────────────────────────────

async function apiFetch<T>(path: string, options: FetchOptions = {}): Promise<T> {
  const { companyId, headers = {}, body, retry4xx = false, ...rest } = options;
  const method = (rest.method ?? 'GET').toUpperCase();
  const url = `${BASE}${path}`;

  // Static across retry attempts; only `signal` is per-attempt.
  const baseInit: RequestInit = {
    ...rest,
    method,
    headers: {
      accept: 'application/json',
      'accept-language': 'pl-PL',
      'x-launcher-type': 'ANDROID_APP',
      'x-mobile-version': '4.0.0',
      // Patchright drives a real chrome that manages its own cookie jar +
      // sends a real chrome UA — overriding either confuses CF.
      ...(!USE_PATCHRIGHT && cfSession.userAgent ? { 'user-agent': cfSession.userAgent } : {}),
      ...(!USE_PATCHRIGHT && cfSession.cookie ? { cookie: cfSession.cookie } : {}),
      ...(companyId ? { 'company-id': companyId } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  };

  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
    await limiter.acquire();

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    const init: RequestInit = { ...baseInit, signal: ctrl.signal };
    try {
      const res = USE_PATCHRIGHT
        ? await cfFetch(url, init, REQUEST_TIMEOUT_MS)
        : await fetch(url, init);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const cfChallenge = isCloudflareChallenge(res.status, text);
        const snippet = cfChallenge ? cfChallengeHint() : text;
        const err = new HttpError(method, path, res.status, snippet);
        if (attempt < RETRY_MAX && (cfChallenge || isRetryable(res.status, retry4xx))) {
          lastErr = err;
          const wait = cfChallenge ? cfBackoffMs(attempt) : backoffMs(attempt);
          await sleep(wait);
          continue;
        }
        throw err;
      }
      const ct = res.headers.get('content-type') ?? '';
      if (!ct.includes('application/json')) {
        return undefined as T;
      }
      return (await res.json()) as T;
    } catch (err) {
      const e = err as Error & { name?: string };
      if (e.name === 'AbortError' || e.message?.includes('fetch failed') || e.message?.includes('ECONN')) {
        lastErr = e;
        if (attempt < RETRY_MAX) {
          await sleep(backoffMs(attempt));
          continue;
        }
      }
      throw err;
    } finally {
      clearTimeout(timer);
      limiter.release();
    }
  }
  throw lastErr ?? new Error(`apiFetch fell through without result: ${method} ${path}`);
}

export class HttpError extends Error {
  constructor(public method: string, public path: string, public status: number, public bodySnippet: string) {
    super(`${method} ${path} → ${status}: ${bodySnippet.slice(0, 300)}`);
    this.name = 'HttpError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── public api ───────────────────────────────────────────────────────────────

export function get<T>(path: string, options: FetchOptions = {}): Promise<T> {
  return apiFetch<T>(path, options);
}

export function post<T>(path: string, body: unknown, options: FetchOptions = {}): Promise<T> {
  return apiFetch<T>(path, { ...options, method: 'POST', body });
}

// ── pure utilities ───────────────────────────────────────────────────────────

export function parsePrice(val: string | number | null | undefined): number | null {
  if (val == null) return null;
  if (typeof val === 'number') return val;
  // Polish format may use comma as decimal: "1 234,50 zł" → 1234.50
  const cleaned = String(val)
    .replace(/\s+/g, '')
    .replace(/zł/gi, '')
    .replace(',', '.');
  const n = parseFloat(cleaned.replace(/[^\d.\-]/g, ''));
  return isNaN(n) ? null : n;
}

/**
 * Parse the per-meal "info" string returned by the menu endpoint.
 * Format: "300 kcal • B:19g • W:30g • T:11g"
 *   B = Białka (protein), W = Węglowodany (carbs), T = Tłuszcze (fat)
 */
export function parseInfoMacros(info: string | null | undefined): {
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
} {
  const out = { kcal: null as number | null, protein_g: null as number | null, carbs_g: null as number | null, fat_g: null as number | null };
  if (!info) return out;
  const kcalMatch = info.match(/(\d+(?:[.,]\d+)?)\s*kcal/i);
  if (kcalMatch) out.kcal = parseFloat(kcalMatch[1].replace(',', '.'));
  const bMatch = info.match(/B:\s*(\d+(?:[.,]\d+)?)\s*g/i);
  if (bMatch) out.protein_g = parseFloat(bMatch[1].replace(',', '.'));
  const wMatch = info.match(/W:\s*(\d+(?:[.,]\d+)?)\s*g/i);
  if (wMatch) out.carbs_g = parseFloat(wMatch[1].replace(',', '.'));
  const tMatch = info.match(/T:\s*(\d+(?:[.,]\d+)?)\s*g/i);
  if (tMatch) out.fat_g = parseFloat(tMatch[1].replace(',', '.'));
  return out;
}

/** Parse strings like "300.45 kcal / 1257 kJ" to a number. */
export function parseKcalNumber(val: string | number | null | undefined): number | null {
  if (val == null) return null;
  if (typeof val === 'number') return val;
  const m = String(val).match(/(\d+(?:[.,]\d+)?)/);
  return m ? parseFloat(m[1].replace(',', '.')) : null;
}

/** Parse strings like "18.87g" → 18.87. */
export function parseGrams(val: string | number | null | undefined): number | null {
  if (val == null) return null;
  if (typeof val === 'number') return val;
  const m = String(val).match(/(\d+(?:[.,]\d+)?)/);
  return m ? parseFloat(m[1].replace(',', '.')) : null;
}

export function futureWeekdays(
  count: number,
  { includeSaturday = false, includeSunday = false, fromDaysOffset = 1 } = {},
): string[] {
  const dates: string[] = [];
  const d = new Date();
  d.setDate(d.getDate() + fromDaysOffset);
  while (dates.length < count) {
    const day = d.getDay(); // 0 = Sun, 6 = Sat
    const skip = (day === 0 && !includeSunday) || (day === 6 && !includeSaturday);
    if (!skip) dates.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

/** Inclusive range of N future calendar dates (no weekend filtering). */
export function nextNDates(count: number, fromDaysOffset = 0): string[] {
  const out: string[] = [];
  const d = new Date();
  d.setDate(d.getDate() + fromDaysOffset);
  for (let i = 0; i < count; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return out;
}
