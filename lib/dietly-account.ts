// Server-side glue between the dashboard and the user's dietly account.
//
// The dietly session (remember-me + SESSION cookies from the mobile API) is
// kept in one httpOnly cookie on *our* origin — the browser can't carry
// dietly.pl's own cookies cross-origin, and a server-side map would drop the
// login on every restart. The password itself is never stored.

import { DietlyClient } from "@/mcp/client";
import { HttpError } from "@/scraper/api";

export const SESSION_COOKIE = "dietlownik_dietly";
export const SESSION_MAX_AGE_S = 60 * 60 * 24 * 30;

// Profile basket endpoints. Verified 2026-09-22: the mobile host and
// dietly.pl share one basket store, and writing through calculate-price is
// what persists it (there is no separate "save" call).
export const BASKET_RESTORE_PATH = "/api/profile/shopping-cart/restore";
export const BASKET_CALCULATE_PATH =
  "/api/dietly/profile/shopping-cart/calculate-price";

export const basketUrl = (companyId: string): string =>
  `https://dietly.pl/koszyk/${encodeURIComponent(companyId)}`;

export interface StoredSession {
  readonly email: string;
  readonly rememberMe: string;
  readonly sessionCookie: string;
}

export const encodeSession = (s: Readonly<StoredSession>): string =>
  Buffer.from(JSON.stringify(s), "utf-8").toString("base64url");

export const decodeSession = (
  raw: string | undefined
): StoredSession | null => {
  if (raw === undefined || raw === "") {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf-8")
    );
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "email" in parsed &&
      "rememberMe" in parsed &&
      "sessionCookie" in parsed &&
      typeof parsed.email === "string" &&
      typeof parsed.rememberMe === "string" &&
      typeof parsed.sessionCookie === "string"
    ) {
      return {
        email: parsed.email,
        rememberMe: parsed.rememberMe,
        sessionCookie: parsed.sessionCookie,
      };
    }
  } catch {
    // Tampered or legacy cookie — treat as logged out.
  }
  return null;
};

export const clientFor = (s: Readonly<StoredSession>): DietlyClient => {
  const client = new DietlyClient();
  client.setSession(s.email, s.rememberMe, s.sessionCookie);
  return client;
};

/** The session as it stands after a call — dietly may rotate SESSION. */
export const currentSession = (
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- DietlyClient is a class instance; only getSession is read
  client: DietlyClient,
  email: string
): StoredSession | null => {
  const s = client.getSession(email);
  return s === undefined
    ? null
    : { email, rememberMe: s.rememberMe, sessionCookie: s.sessionCookie };
};

/** dietly's error bodies are `{ title, message }`; fall back to the status. */
export const dietlyMessage = (error: unknown): string => {
  if (error instanceof HttpError) {
    try {
      const body: unknown = JSON.parse(error.bodySnippet);
      if (
        body !== null &&
        typeof body === "object" &&
        "message" in body &&
        typeof body.message === "string" &&
        body.message !== ""
      ) {
        return body.message;
      }
    } catch {
      // Non-JSON body (HTML error page, Cloudflare) — use the status below.
    }
    return `dietly odpowiedziało ${error.status}`;
  }
  return error instanceof Error ? error.message : String(error);
};

export const isAuthError = (error: unknown): boolean =>
  error instanceof HttpError && (error.status === 401 || error.status === 403);
