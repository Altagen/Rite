/**
 * Tiny path-based router (no dependency). The server serves the SPA on every path
 * (SPA fallback), so `/admin` and `/collections` are real URLs the client renders —
 * groundwork for serving the admin console on its own (rite-admin-console-split).
 *
 * Only what we need: the current pathname + `navigate()` (pushState) + back/forward
 * (popstate). Guards live in the caller (e.g. `/admin` needs the admin role).
 */

import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();
function emit() {
  for (const l of listeners) l();
}

// Intercept pushState/replaceState once so programmatic navigation notifies us.
let patched = false;
function patchHistory() {
  if (patched || typeof window === 'undefined') return;
  patched = true;
  for (const m of ['pushState', 'replaceState'] as const) {
    const orig = history[m].bind(history);
    history[m] = ((...args: Parameters<History['pushState']>) => {
      orig(...args);
      emit();
    }) as History[typeof m];
  }
  window.addEventListener('popstate', emit);
}

function subscribe(cb: () => void) {
  patchHistory();
  listeners.add(cb);
  return () => listeners.delete(cb);
}
const getSnapshot = () => (typeof window === 'undefined' ? '/' : window.location.pathname);

/** Navigate to a path (no reload). Same path is a no-op. */
export function navigate(path: string) {
  if (typeof window === 'undefined' || window.location.pathname === path) return;
  history.pushState({}, '', path);
}

/** Reactive current pathname (normalised: trailing slash trimmed, defaults to '/'). */
export function useRoutePath(): string {
  const p = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}
