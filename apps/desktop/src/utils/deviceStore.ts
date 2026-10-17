/**
 * Where a preference about THIS MACHINE is kept.
 *
 * `localStorage` was the obvious answer and is the wrong one in the desktop shell. The
 * window loads `http://127.0.0.1:<port>`, the shell's server binds `:0`, and the kernel
 * hands out a different port on every launch — so the origin `localStorage` is keyed by is
 * new every time, and everything stored there was gone on the next start: the toolbar, the
 * theme, the language, the snippets, the pinned dashboard cards. The randomness is
 * deliberate (ADR 0009 pairs a random loopback port with a per-window token), so the fix
 * is not to pin the port and trade a security property for a convenience.
 *
 * So: in the shell these live in a file the shell owns (`device.json`, beside the vault
 * roster rather than inside a vault — a vault carried to another computer must not
 * rearrange its UI there), injected at startup and written back over the same IPC channel
 * the rest of the shell uses. In a browser the origin is stable, and `localStorage` stays.
 *
 * The API is `localStorage`'s on purpose: every call site was already written against it.
 *
 * One thing it does NOT do that `localStorage` does: tell the other windows. Two desktop
 * windows each hold their own injected snapshot, and the shell's write is
 * read-modify-write, so nothing is lost — but a preference changed in one window is not
 * visible in another until that one is reopened. `localStorage` fires a `storage` event
 * across tabs and this has no equivalent yet. It is a staleness, not a loss, and it is
 * worth less than the relaunch it fixes.
 *
 * Nothing is imported here, deliberately: every store imports this module, and a check can
 * load it directly to drive both worlds (`e2e/device-prefs-check.mjs`). The one thing it
 * would want — `isNativeShell()` — is a read of the same injected global, and the question
 * this module actually asks is narrower: is there a snapshot to read and write?
 */

/** The shell's injected snapshot, kept in memory and updated as we write. */
function injected(): Record<string, string> | null {
    if (typeof window === 'undefined') return null;
    const raw = window.__RITE_DEVICE__;
    if (!raw || typeof raw !== 'object') return null;
    return raw as Record<string, string>;
}

/**
 * Preferences are strings here, as they are in `localStorage`, so a caller that does its
 * own `JSON.parse` keeps working. A value the file holds as something else (hand-edited,
 * or written by an older build) is stringified rather than dropped.
 */
function asString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export const deviceStore = {
  getItem(key: string): string | null {
    const shell = injected();
    if (shell) return asString(shell[key]);
    try {
      return localStorage.getItem(key);
    } catch {
      // Private window, blocked site data: a missing preference, not an error.
      return null;
    }
  },

  setItem(key: string, value: string): void {
    const shell = injected();
    if (shell) {
      // In memory first, so a read in the same tick sees it — the file write is a round
      // trip through the shell and nothing waits for it.
      shell[key] = value;
      window.ipc?.postMessage(JSON.stringify({ type: 'device-set', key, value }));
      return;
    }
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage unavailable — keep it for this session only */
    }
  },

  removeItem(key: string): void {
    const shell = injected();
    if (shell) {
      delete shell[key];
      window.ipc?.postMessage(JSON.stringify({ type: 'device-set', key, value: null }));
      return;
    }
    try {
      localStorage.removeItem(key);
    } catch {
      /* nothing to remove */
    }
  },
};
