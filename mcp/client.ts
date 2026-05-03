import { HttpError } from "@/scraper/api";
import {
  LOGIN_DEVICE_TOKEN,
  LOGIN_PATH,
  MOBILE_HEADERS,
  buildUrl,
  fetchWithRetry,
  getSetCookieValues,
  parseResponse,
  readCookieValue,
} from "@/mcp/http";

// --- Public types ---

export interface DietlySession {
  rememberMe: string;
  sessionCookie: string;
}

// --- Helpers ---

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function buildAuthCookie(session: DietlySession): string {
  return `remember-me=${session.rememberMe}; ${session.sessionCookie}`;
}

/**
 * Wraps the dietly.pl mobile API and owns the per-email session cache.
 * One process-wide instance is fine; sessions are keyed by normalized email.
 */
export class DietlyClient {
  private readonly sessions = new Map<string, DietlySession>();

  // --- Auth ---

  /**
   * POST /api/auth/login. On success, stores the session under `email` so
   * subsequent `authGet`/`authPost` calls authenticate transparently.
   */
  async login(
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

    const sessionCookie = `SESSION=${sessionValue}`;
    this.setSession(email, rememberMe, sessionCookie);

    return { rememberMe, sessionCookie };
  }

  // --- Authenticated requests ---

  async authGet<T>(email: string, path: string, companyId?: string): Promise<T> {
    const session = this.sessions.get(normalizeEmail(email));
    if (!session) {
      throw new HttpError("GET", path, 401, `No stored session for ${email}`);
    }

    const response = await fetchWithRetry(buildUrl(path), {
      method: "GET",
      headers: this.authHeaders(session, companyId ? { "company-id": companyId } : {}),
      cache: "no-store",
    });

    this.refreshSessionFromResponse(email, session, response.headers);
    return parseResponse<T>(response, "GET", path);
  }

  async authPost<T>(
    email: string,
    path: string,
    body: unknown,
    companyId?: string
  ): Promise<T> {
    const session = this.sessions.get(normalizeEmail(email));
    if (!session) {
      throw new HttpError("POST", path, 401, `No stored session for ${email}`);
    }

    const response = await fetchWithRetry(buildUrl(path), {
      method: "POST",
      headers: this.authHeaders(session, {
        "content-type": "application/json",
        ...(companyId ? { "company-id": companyId } : {}),
      }),
      body: JSON.stringify(body),
    });

    this.refreshSessionFromResponse(email, session, response.headers);
    return parseResponse<T>(response, "POST", path);
  }

  // --- Anonymous requests ---

  async anonGet<T>(path: string, companyId?: string): Promise<T> {
    const response = await fetchWithRetry(buildUrl(path), {
      method: "GET",
      headers: this.anonHeaders(companyId ? { "company-id": companyId } : {}),
    });

    return parseResponse<T>(response, "GET", path);
  }

  // --- Session introspection ---

  getSession(email: string): DietlySession | undefined {
    return this.sessions.get(normalizeEmail(email));
  }

  // --- Internals ---

  /**
   * Public for the api.ts shim only — Phase 3 should call `login()` instead
   * of injecting sessions directly. Kept on the public surface so the legacy
   * `setSession` re-export keeps working until tools are migrated.
   */
  setSession(email: string, rememberMe: string, sessionCookie: string): void {
    this.sessions.set(normalizeEmail(email), { rememberMe, sessionCookie });
  }

  private refreshSessionFromResponse(
    email: string,
    currentSession: DietlySession,
    headers: Headers
  ): void {
    const setCookie = getSetCookieValues(headers);
    if (setCookie.length === 0) return;

    const rememberMe =
      readCookieValue(setCookie, "remember-me") ?? currentSession.rememberMe;
    const sessionValue = readCookieValue(setCookie, "SESSION");
    const sessionCookie = sessionValue
      ? `SESSION=${sessionValue}`
      : currentSession.sessionCookie;

    this.setSession(email, rememberMe, sessionCookie);
  }

  private authHeaders(
    session: DietlySession,
    extras: Record<string, string> = {}
  ): Headers {
    const headers = new Headers({ ...MOBILE_HEADERS, ...extras });
    headers.set("cookie", buildAuthCookie(session));
    return headers;
  }

  private anonHeaders(extras: Record<string, string> = {}): Headers {
    return new Headers({ ...MOBILE_HEADERS, ...extras });
  }
}

// Intentionally NO singleton. The cookie cache is per-instance; route code
// must create one DietlyClient per MCP transport session so cookies don't
// leak across users / Claude conversations. See app/api/mcp/route.ts.
