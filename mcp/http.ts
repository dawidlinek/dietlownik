import { HttpError, sleep } from "@/scraper/api";
import { isCloudflareChallenge } from "@/scraper/cf-shared";

// --- Wire-level constants ---

export const BASE = "https://aplikacja.dietly.pl";
export const LOGIN_PATH = "/api/auth/login";
export const LOGIN_DEVICE_TOKEN = "dietly-mcp-device-token";

export const MOBILE_HEADERS = {
  accept: "application/json",
  "accept-language": "pl-PL",
  "user-agent": "okhttp/4.9.2",
  "x-launcher-type": "ANDROID_APP",
  "x-mobile-version": "4.0.0",
};

// --- URL + cookie helpers ---

export function buildUrl(path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }
  if (path.startsWith("/")) {
    return `${BASE}${path}`;
  }
  return `${BASE}/${path}`;
}

export function getSetCookieValues(headers: Headers): string[] {
  const h = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") {
    return h.getSetCookie();
  }

  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

export function readCookieValue(
  setCookieHeaders: string[],
  cookieName: string
): string | null {
  const joined = setCookieHeaders.join(", ");
  const re = new RegExp(`${cookieName}=([^;,\\s]+)`, "i");
  const match = joined.match(re);
  return match ? match[1] : null;
}

// --- Fetch + response helpers ---

export async function fetchWithRetry(
  url: string,
  init: RequestInit
): Promise<Response> {
  const RETRY_MAX = 3;

  for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
    try {
      const res = await fetch(url, init);
      const cloned = res.clone();
      const text = await cloned.text().catch(() => "");

      if (!res.ok && isCloudflareChallenge(res.status, text)) {
        if (attempt < RETRY_MAX) {
          const wait = 5000 * 2 ** (attempt - 1) + Math.random() * 2000;
          console.warn(
            `[MCP] Cloudflare blockage on ${url}. Retrying in ${Math.round(wait)}ms`
          );
          await sleep(wait);
          continue;
        }
      }

      if (!res.ok && res.status >= 500) {
        if (attempt < RETRY_MAX) {
          const wait = 1000 * attempt;
          console.warn(`[MCP] 5xx error on ${url}. Retrying in ${wait}ms`);
          await sleep(wait);
          continue;
        }
      }

      return res;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      if (
        attempt < RETRY_MAX &&
        (msg.includes("fetch failed") || msg.includes("ECONN"))
      ) {
        await sleep(1000 * attempt);
        continue;
      }
      throw error;
    }
  }
  // Unreachable: every iteration either returns or continues; the final
  // attempt's failure throws.
  throw new Error(`fetchWithRetry exhausted attempts: ${url}`);
}

export async function parseResponse<T>(
  res: Response,
  method: string,
  path: string
): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    throw new HttpError(method, path, res.status, text);
  }

  if (!text) {
    return null as T;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}
