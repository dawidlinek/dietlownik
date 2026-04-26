import { HttpError } from "@/scraper/api";
import { getSession, setSession, type DietlySession } from "@/mcp/session";

const BASE = "https://aplikacja.dietly.pl";
const LOGIN_PATH = "/api/auth/login";
const LOGIN_DEVICE_TOKEN = "dietly-mcp-device-token";

const MOBILE_HEADERS = {
  "x-launcher-type": "ANDROID_APP",
  "x-mobile-version": "4.0.0",
  "accept-language": "pl-PL",
  accept: "application/json",
  "user-agent": "okhttp/4.9.2",
};

function buildUrl(path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  if (path.startsWith("/")) return `${BASE}${path}`;
  return `${BASE}/${path}`;
}

function getSetCookieValues(headers: Headers): string[] {
  const h = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") {
    return h.getSetCookie();
  }

  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

function readCookieValue(setCookieHeaders: string[], cookieName: string): string | null {
  const joined = setCookieHeaders.join(", ");
  const re = new RegExp(`${cookieName}=([^;,\\s]+)`, "i");
  const match = joined.match(re);
  return match ? match[1] : null;
}

function buildAuthCookie(session: DietlySession): string {
  return `remember-me=${session.rememberMe}; ${session.sessionCookie}`;
}

function refreshSessionFromResponse(
  email: string,
  currentSession: DietlySession,
  headers: Headers
): void {
  const setCookie = getSetCookieValues(headers);
  if (setCookie.length === 0) return;

  const rememberMe = readCookieValue(setCookie, "remember-me") ?? currentSession.rememberMe;
  const sessionValue = readCookieValue(setCookie, "SESSION");
  const sessionCookie = sessionValue
    ? `SESSION=${sessionValue}`
    : currentSession.sessionCookie;

  setSession(email, rememberMe, sessionCookie);
}

function isCloudflareChallenge(status: number, body: string): boolean {
  if (status !== 403 && status !== 503 && status !== 429) return false;
  return body.includes("Just a moment") || body.includes("cf-browser-verification") || body.includes("__cf_chl_");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  const RETRY_MAX = 3;
  let lastRes: Response | undefined;

  for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
    try {
      const res = await fetch(url, init);
      const cloned = res.clone();
      const text = await cloned.text().catch(() => "");
      
      if (!res.ok && isCloudflareChallenge(res.status, text)) {
        if (attempt < RETRY_MAX) {
          const wait = 5000 * 2 ** (attempt - 1) + Math.random() * 2000;
          console.warn(`[MCP] Cloudflare blockage on ${url}. Retrying in ${Math.round(wait)}ms`);
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
    } catch (err: any) {
      if (attempt < RETRY_MAX && (err.message?.includes("fetch failed") || err.message?.includes("ECONN"))) {
        await sleep(1000 * attempt);
        continue;
      }
      throw err;
    }
  }
  return lastRes as Response;
}

async function parseResponse<T>(res: Response, method: string, path: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    throw new HttpError(method, path, res.status, text);
  }

  if (!text) return null as T;

  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

function authHeaders(
  session: DietlySession,
  extras: Record<string, string> = {}
): Headers {
  const headers = new Headers({ ...MOBILE_HEADERS, ...extras });
  headers.set("cookie", buildAuthCookie(session));
  return headers;
}

function anonHeaders(extras: Record<string, string> = {}): Headers {
  return new Headers({ ...MOBILE_HEADERS, ...extras });
}

export async function loginRequest(
  email: string,
  password: string
): Promise<{ rememberMe: string; sessionCookie: string }> {
  const form = new FormData();
  form.set("username", email);
  form.set("password", password);
  form.set("deviceToken", LOGIN_DEVICE_TOKEN);
  form.set("notificationsPermitted", "true");

  const response = await fetchWithRetry(buildUrl(LOGIN_PATH), {
    method: "POST",
    headers: new Headers(MOBILE_HEADERS),
    body: form,
    cache: "no-store",
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new HttpError("POST", LOGIN_PATH, response.status, bodyText);
  }

  const setCookie = getSetCookieValues(response.headers);
  const rememberMe = readCookieValue(setCookie, "remember-me");
  const sessionValue = readCookieValue(setCookie, "SESSION");

  if (!rememberMe || !sessionValue) {
    throw new HttpError(
      "POST",
      LOGIN_PATH,
      500,
      "Login succeeded but session cookies were missing"
    );
  }

  return {
    rememberMe,
    sessionCookie: `SESSION=${sessionValue}`,
  };
}

export async function authGet<T>(
  email: string,
  path: string,
  companyId?: string
): Promise<T> {
  const session = getSession(email);
  if (!session) {
    throw new HttpError("GET", path, 401, `No stored session for ${email}`);
  }

  const response = await fetchWithRetry(buildUrl(path), {
    method: "GET",
    headers: authHeaders(session, companyId ? { "company-id": companyId } : {}),
    cache: "no-store",
  });

  refreshSessionFromResponse(email, session, response.headers);
  return parseResponse<T>(response, "GET", path);
}

export async function authPost<T>(
  email: string,
  path: string,
  body: unknown,
  companyId?: string
): Promise<T> {
  const session = getSession(email);
  if (!session) {
    throw new HttpError("POST", path, 401, `No stored session for ${email}`);
  }

  const response = await fetchWithRetry(buildUrl(path), {
    method: "POST",
    headers: authHeaders(session, {
      "content-type": "application/json",
      ...(companyId ? { "company-id": companyId } : {}),
    }),
    body: JSON.stringify(body),
  });

  refreshSessionFromResponse(email, session, response.headers);
  return parseResponse<T>(response, "POST", path);
}

export async function anonGet<T>(
  path: string,
  companyId?: string
): Promise<T> {
  const response = await fetchWithRetry(buildUrl(path), {
    method: "GET",
    headers: anonHeaders(companyId ? { "company-id": companyId } : {}),
  });

  return parseResponse<T>(response, "GET", path);
}
