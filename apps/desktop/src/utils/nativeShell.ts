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
  | { kind: 'local'; path?: string } // path ⇒ a specific vault (multi-vault, ADR 0014)
  | { kind: 'server'; id: string; url: string; label?: string };

/** A local vault the shell knows about (from `window.__RITE_VAULTS__`). */
export interface NativeVault {
  path: string;
  label: string;
}

/**
 * The local vaults the shell injected for this window (ADR 0014 multi-vault). The shell
 * seeds the default vault, so this is non-empty natively; empty in the web build.
 */
export function nativeVaults(): NativeVault[] {
  if (typeof window === 'undefined') return [];
  const v = window.__RITE_VAULTS__;
  return Array.isArray(v) ? v : [];
}

/** A vault-management command the hub asks the shell to run (ADR 0014). */
export type VaultCommand =
  | { type: 'vault-new' } // shell shows a save dialog
  | { type: 'vault-open-file' } // shell shows an open dialog
  | { type: 'vault-rename'; path: string; label: string }
  | { type: 'vault-forget'; path: string }; // drop from the roster (keeps the file)

/**
 * Ask the native shell to run a vault-management command. Returns false when there's no shell
 * (web build). The shell pushes the updated roster back via a `rite-vaults-changed` event.
 */
export function sendVaultCommand(cmd: VaultCommand): boolean {
  if (typeof window === 'undefined' || !window.ipc) return false;
  window.ipc.postMessage(JSON.stringify(cmd));
  return true;
}

/**
 * Subscribe to shell-pushed roster changes (the shell fires `rite-vaults-changed` after a vault
 * command). Returns an unsubscribe fn. No-op in the web build.
 */
export function onVaultsChanged(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('rite-vaults-changed', handler);
  return () => window.removeEventListener('rite-vaults-changed', handler);
}

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
