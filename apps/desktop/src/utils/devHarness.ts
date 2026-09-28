/**
 * Dev-only harness for the browser mock (`vite dev`, no Rust backend).
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
