/**
 * Dev-only harness for the browser mock (no Rust backend).
 *
 * TOGETHER WITH `applyDevShell` THIS REPLACES `design/mock/`. That folder held a
 * hand-written copy of the screens so a shape could be looked at without a binary, and it
 * drifted every time the real screens moved — because a copy always does. The real
 * components render here instead, with invented answers from `utils/mockBackend`, and
 * there is nothing left to keep in step.
 *
 * TWO AXES, WHICH THE TWO MOCK PAGES CONFLATED INTO TWO FILES:
 *
 *   ?shell=desktop  the native shell around a local vault  (was desktop.html)
 *   ?harness=app    a browser signed into an instance      (was web.html)
 *   ?harness=admin  the same browser, on the console
 *
 * They are independent: the shell is whether wry injected a token, the context is
 * whether the server runs accounts. One switch per axis rather than one page per
 * combination somebody thought to draw.
 *
 * A real server session needs vault crypto the mock can't produce, so the
 * accounts surfaces (server workspace, Teams, Collections, Administration) are
 * otherwise unreachable when iterating on the UI standalone. Append
 * `?harness=admin` (or `teams` / `collections` / `app`) to seed a synthetic
 * admin session and jump straight to that surface — enough to browse and
 * screenshot every server/admin screen. Real name-escrow crypto fails
 * gracefully to id fallbacks under the fake keys.
 *
 * Guarded by `import.meta.env.DEV` and the `?harness` param: a strict no-op in
 * the production build and in normal dev use.
 */
import { useServerSession } from '../store/serverSessionStore';
import { navigate } from '../store/route';

const HARNESS_KEY = 'rite-dev-harness';

/**
 * The requested harness surface, or null when off. Empty value defaults to `admin`.
 * Read from the `?harness` query, falling back to sessionStorage: our own `navigate()`
 * (pushState with a bare path) drops the query, and the mock's `server_mode` runs after
 * that — so the flag has to outlive the URL for the whole tab session.
 */
export function harnessTarget(): string | null {
  if (!import.meta.env.DEV || typeof window === 'undefined') return null;
  const raw = new URLSearchParams(location.search).get('harness');
  if (raw !== null) return raw || 'admin';
  try {
    return sessionStorage.getItem(HARNESS_KEY);
  } catch {
    return null;
  }
}

/** True whenever a harness surface is requested — the mock reads this to behave as a server. */
export function harnessOn(): boolean {
  return harnessTarget() !== null;
}

const SHELL_KEY = 'rite-dev-shell';

/**
 * WHICH SHELL THE PREVIEW SHOULD PRETEND TO BE — `?shell=desktop`, or nothing for web.
 *
 * This is what replaced `design/mock/desktop.html` and `design/mock/web.html`. The two
 * pages existed because the mock had no way to be one or the other, so it was written
 * twice; the real app already decides from `window.__RITE_TOKEN__` and
 * `__RITE_CONTEXT__`, which the native shell injects. Setting them here makes
 * `isNativeShell()` true and every screen that branches on it — the vault pastille, the
 * local library, focus mode, the Labels section of Settings — render as the desktop does.
 *
 * Nothing simulated: the components are the shipped ones and the branch is the shipped
 * branch. What is invented is only which side of it this tab is on.
 */
export function shellTarget(): 'desktop' | 'web' {
  if (!import.meta.env.DEV || typeof window === 'undefined') return 'web';
  const raw = new URLSearchParams(location.search).get('shell');
  if (raw !== null) return raw === 'desktop' ? 'desktop' : 'web';
  try {
    return sessionStorage.getItem(SHELL_KEY) === 'desktop' ? 'desktop' : 'web';
  } catch {
    return 'web';
  }
}

/** Put the preview in the desktop shell's skin, if it was asked for. Call before render. */
export function applyDevShell(): void {
  if (!import.meta.env.DEV || typeof window === 'undefined') return;
  if (shellTarget() !== 'desktop') return;
  try {
    sessionStorage.setItem(SHELL_KEY, 'desktop');
  } catch {
    // Same as the harness: the query-param path still works for one load.
  }
  // The two globals the native shell injects (ADR 0014 phase 4). A token the mock never
  // checks and a context naming the vault this window was opened for.
  window.__RITE_TOKEN__ = 'dev-preview';
  window.__RITE_CONTEXT__ = { kind: 'local', label: 'Preview vault' };
}

/** Seed a synthetic admin session and route to the requested surface. Call once at boot. */
export function applyDevHarness(): void {
  const target = harnessTarget();
  if (!target) return;
  // Persist for the tab: navigate() below drops the query, but the mock still needs to
  // report accounts mode on every later server_mode call (and across reloads).
  try {
    sessionStorage.setItem(HARNESS_KEY, target);
  } catch {
    // sessionStorage unavailable — the query-param path still works for a single load.
  }
  // RAM-only 32-byte key blobs. They satisfy the "session is unlocked" checks; the escrow
  // crypto that would use them is wrapped in try/catch and falls back to id labels.
  const blob = () => new Uint8Array(32).fill(7);
  useServerSession.setState({
    user: {
      id: 'mock-admin',
      username: 'alex',
      role: 'admin',
      status: 'active',
      createdAt: Math.floor(Date.now() / 1000),
      mustChangePassword: false,
    },
    userKey: blob(),
    privateKey: blob(),
    publicKey: blob(),
    loading: false,
  });
  navigate(target === 'app' ? '/' : `/${target}`);
}
