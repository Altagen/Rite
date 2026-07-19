/**
 * Native multi-window shell bridge (ADR 0014 phase 4).
 *
 * The desktop shell (wry) runs one window per context, each with its own loopback
 * server. It injects the launch token + the window's target context, and exposes
 * an IPC channel so the frontend can ask it to open (or focus) another context in
 * its own window — instead of the old reload-based context flip. In the browser
 * (web build) none of this is present, so every helper degrades to a no-op.
 */

import { Backend } from './backend';

/** True when running inside the native desktop shell (a launch token is present). */
export function isNativeShell(): boolean {
  return typeof window !== 'undefined' && !!window.__RITE_TOKEN__;
}

/** The context this native window was opened for, if any. */
export function nativeContext(): RiteNativeContext | undefined {
  return typeof window !== 'undefined' ? window.__RITE_CONTEXT__ : undefined;
}

/** A context the hub can ask the shell to open in its own window. */
export type OpenContextRequest =
  | { kind: 'local' }
  | { kind: 'server'; id: string; url: string; label?: string };

/**
 * Ask the native shell to open the given context in a window (or focus it if it's
 * already open — the shell's one-window-per-context registry decides). Returns
 * false when there is no shell to ask (web build), so callers can fall back.
 */
export function requestOpenContext(request: OpenContextRequest): boolean {
  if (typeof window === 'undefined' || !window.ipc) return false;
  window.ipc.postMessage(JSON.stringify({ type: 'open-context', ...request }));
  return true;
}

/**
 * On a server-context window, activate the injected server so this window's local
 * server proxies to it, then reload once into the remote's login. Guarded by the
 * current active context so the post-activation reload does not re-trigger. A
 * local window (or the web build) is a no-op.
 */
export async function applyNativeContext(): Promise<void> {
  const ctx = nativeContext();
  if (!ctx || ctx.kind !== 'server' || !ctx.id) return;
  try {
    const current = await Backend.Context.get();
    // Already proxying to this server (post-reload) → nothing to do.
    if (current.active !== 'local' && current.active.id === ctx.id) return;
    await Backend.Context.setActive(ctx.id);
    window.location.reload();
  } catch {
    // No context control plane here — leave the window on its default view.
  }
}
