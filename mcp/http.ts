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

export const buildUrl = (path: string): string => {
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }
  if (path.startsWith("/")) {
    return `${BASE}${path}`;
  }
  return `${BASE}/${path}`;
};

export const getSetCookieValues = (headers: Headers): string[] => {
  const h = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") {
    return h.getSetCookie();
  }

  const single = headers.get("set-cookie");
  return single !== null && single !== "" ? [single] : [];
};

export const readCookieValue = (
  setCookieHeaders: string[],
  cookieName: string
): string | null => {
  const joined = setCookieHeaders.join(", ");
  const re = new RegExp(`${cookieName}=([^;,\\s]+)`, "i");
  const match = joined.match(re);
  return match ? match[1] : null;
};

// --- Fetch + response helpers ---

export const fetchWithRetry = async (
  url: string,
  init: RequestInit
): Promise<Response> => {
  const RETRY_MAX = 3;

  for (let attempt = 1; attempt <= RETRY_MAX; attempt += 1) {
    try {
      const res = await fetch(url, init);

      // Only sniff the body when the response is a failure — cloning + reading
      // a successful body would materialize it twice (here + at the caller)
      // for no benefit; success is the hot path.
      if (!res.ok) {
        const text = await res
          .clone()
          .text()
          .catch(() => "");
        if (isCloudflareChallenge(res.status, text) && attempt < RETRY_MAX) {
          const wait = 5000 * 2 ** (attempt - 1) + Math.random() * 2000;
          console.warn(
            `[MCP] Cloudflare blockage on ${url}. Retrying in ${Math.round(wait)}ms`
          );
          await sleep(wait);
          continue;
        }
        if (res.status >= 500 && attempt < RETRY_MAX) {
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
};

export const parseResponse = async <T>(
  res: Response,
  method: string,
  path: string
): Promise<T> => {
  const text = await res.text();
  if (!res.ok) {
    throw new HttpError(method, path, res.status, text);
  }

  if (text === "") {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- parseResponse contract: empty body resolves to null cast to T
    return null as T;
  }

  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON.parse returns any; caller annotates expected T
    return JSON.parse(text) as T;
  } catch {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- non-JSON body returned as raw text per contract
    return text as T;
  }
};
