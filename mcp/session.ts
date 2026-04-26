export interface DietlySession {
  rememberMe: string;
  sessionCookie: string;
}

const sessions = new Map<string, DietlySession>();

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function setSession(
  email: string,
  rememberMe: string,
  sessionCookie: string
): void {
  sessions.set(normalizeEmail(email), { rememberMe, sessionCookie });
}

export function getSession(email: string): DietlySession | undefined {
  return sessions.get(normalizeEmail(email));
}

export function clearSession(email: string): void {
  sessions.delete(normalizeEmail(email));
}
