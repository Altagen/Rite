/**
 * Server-mode session token (ADR 0010).
 *
 * After logging in to a shared server the client holds an opaque session token,
 * sent as the `Authorization: Bearer` on every request (and as the `?token=` WS
 * param). In local desktop mode this is unused — the loopback launch token
 * (`window.__RITE_TOKEN__`) is used instead. Kept in `sessionStorage` so it
 * survives a reload but not a full close.
 */

const KEY = 'rite.sessionToken';

let cached: string | null = null;

export function getSessionToken(): string | null {
  if (cached !== null) return cached;
  try {
    cached = sessionStorage.getItem(KEY);
  } catch {
    cached = null;
  }
  return cached;
}

export function setSessionToken(token: string): void {
  cached = token;
  try {
    sessionStorage.setItem(KEY, token);
  } catch {
    // sessionStorage unavailable (e.g. some webviews) — keep the in-memory copy.
  }
}

export function clearSessionToken(): void {
  cached = null;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

/** The bearer token to authenticate with: the session token, else the local
 *  shell's launch token. */
export function bearerToken(): string | undefined {
  return getSessionToken() ?? window.__RITE_TOKEN__ ?? undefined;
}
