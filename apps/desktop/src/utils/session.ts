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

/** The bearer token to authenticate with.
 *
 * Native client (launch token present): always the loopback launch token — the
 * local server guards that hop (ADR 0009) and holds the remote session itself
 * when proxying (ADR 0012), so the webview never carries the remote token.
 * Browser (no launch token): the server session token. */
export function bearerToken(): string | undefined {
  return window.__RITE_TOKEN__ ?? getSessionToken() ?? undefined;
}
