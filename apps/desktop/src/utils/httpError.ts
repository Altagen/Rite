/**
 * Typed HTTP transport errors + a global "unauthorized" hook, so callers and the app shell
 * can react to connection/session failures (design/mock/errors.html) instead of surfacing a
 * raw message. Kept dependency-free (no store import) to avoid cycles with httpRoutes.
 */

export type HttpErrorKind =
  | 'unreachable' // fetch rejected — couldn't reach the server at all
  | 'starting' // 503 — server up but not ready
  | 'session-expired' // 401 — token revoked/expired
  | 'server-error' // 5xx
  | 'http'; // any other non-ok status

export class RiteHttpError extends Error {
  status: number; // 0 for a network failure
  kind: HttpErrorKind;
  constructor(message: string, status: number, kind: HttpErrorKind) {
    super(message);
    this.name = 'RiteHttpError';
    this.status = status;
    this.kind = kind;
  }
}

export function kindFor(status: number): HttpErrorKind {
  if (status === 0) return 'unreachable';
  if (status === 503) return 'starting';
  if (status === 401) return 'session-expired';
  if (status >= 500) return 'server-error';
  return 'http';
}

// Registered by the session store; called once per 401 so a mid-session session-expiry can
// sign the user out and show the "session expired" screen rather than a broken shell.
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}
export function notifyUnauthorized() {
  onUnauthorized?.();
}
