/**
 * Full-page connection / error states (design/mock/errors.html). Shown when the app can't
 * boot or the session is gone — every failure path gets a clear message and a safe way
 * forward, never a blank screen or a raw stack. A dropped connection mid-session uses the
 * non-blocking OfflineBanner instead; this is the takeover for "can't proceed" cases.
 */

import type { HttpErrorKind } from '../utils/httpError';

// Every HttpErrorKind, plus 'offline' (client-side) and a 'generic' fallback.
export type ConnErrorKind = HttpErrorKind | 'offline' | 'generic';

const ICONS: Record<ConnErrorKind, string> = {
  starting: 'M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1',
  unreachable: 'M17.5 19a4.5 4.5 0 000-9 6 6 0 00-11.3-1.5A4 4 0 006 19zM3 3l18 18',
  offline: 'M1 1l22 22M8.5 16.5a5 5 0 017 0M5 12.9a10 10 0 0114-.1M12 20h.01',
  'session-expired': 'M12 8v4l3 2M12 3a9 9 0 100 18 9 9 0 000-18z',
  'server-error': 'M12 3l10 18H2zM12 9v5M12 17.5h.01',
  http: 'M12 3l10 18H2zM12 9v5M12 17.5h.01',
  generic: 'M12 3l10 18H2zM12 9v5M12 17.5h.01',
};

const CONTENT: Record<
  ConnErrorKind,
  { sev: 'warn' | 'error' | 'info'; title: string; msg: string }
> = {
  http: {
    sev: 'error',
    title: 'Something went wrong',
    msg: 'The request could not be completed. Try again in a moment.',
  },
  starting: {
    sev: 'warn',
    title: 'The server is starting up',
    msg: "It isn't ready yet — this usually clears in a few seconds. We'll keep trying on our own.",
  },
  unreachable: {
    sev: 'warn',
    title: "Can't reach the server",
    msg: 'Check your internet connection, or that the server address is correct. We keep retrying.',
  },
  offline: {
    sev: 'warn',
    title: "You're offline",
    msg: "Your device isn't connected to the internet. Rite will reconnect on its own the moment you're back online.",
  },
  'session-expired': {
    sev: 'info',
    title: 'Your session expired',
    msg: 'For your security you were signed out after inactivity. Sign in again to carry on — your saved connections stay safe and encrypted.',
  },
  'server-error': {
    sev: 'error',
    title: 'Something went wrong',
    msg: "The server hit an unexpected error — it's not you. Try again in a moment; if it keeps happening, contact an admin.",
  },
  generic: {
    sev: 'error',
    title: 'Something went wrong',
    msg: 'An unexpected error occurred. Try again in a moment.',
  },
};

const SEV_CLASS = {
  warn: 'bg-amber-500/15 text-amber-600',
  error: 'bg-red-500/15 text-red-600',
  info: 'bg-primary/15 text-primary',
};

export function ConnectionError({
  kind,
  detail,
  retrying,
  onRetry,
  actionLabel,
  onAction,
}: {
  kind: ConnErrorKind;
  detail?: string;
  /** Show a spinner + "Retrying…" (auto-retry loops). */
  retrying?: boolean;
  onRetry?: () => void;
  /** A primary action (e.g. "Sign in"). Falls back to Retry when absent. */
  actionLabel?: string;
  onAction?: () => void;
}) {
  const c = CONTENT[kind] ?? CONTENT.generic;
  const iconPath = ICONS[kind] ?? ICONS.generic;
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-xl">
        <div className={`mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl ${SEV_CLASS[c.sev]}`}>
          <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <path d={iconPath} />
          </svg>
        </div>
        <h1 className="mb-2 text-xl font-bold text-balance">{c.title}</h1>
        <p className="mb-4 text-sm leading-relaxed text-muted-foreground">{c.msg}</p>
        {retrying && (
          <div className="mx-auto mb-4 inline-flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground">
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-muted border-t-amber-500" />
            Retrying automatically…
          </div>
        )}
        {detail && (
          <div className="mx-auto mb-4 inline-block rounded-lg border border-border bg-background px-3 py-1.5 font-mono text-xs text-muted-foreground">
            {detail}
          </div>
        )}
        <div className="flex justify-center gap-2">
          {onAction && actionLabel ? (
            <button
              onClick={onAction}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              {actionLabel}
            </button>
          ) : onRetry ? (
            <button
              onClick={onRetry}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Try again
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
