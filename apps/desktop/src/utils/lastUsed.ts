/**
 * Per-user, client-local "last connected" cache (ADR 0017 passive "last seen"). Recorded
 * locally when this user opens a connection — never written to the server, never in a shared
 * blob — so it's private, per-user, needs no re-encryption, and works even for view-only
 * collections. Connection ids are UUIDs, so one flat map is collision-free across accounts.
 */

const KEY = 'rite.lastUsed';

function readAll(): Record<string, number> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** Epoch SECONDS of this user's last connect to `id` on this device, or null. */
export function getLastUsed(id: string): number | null {
  return readAll()[id] ?? null;
}

/** Record "connected now" for `id` (epoch seconds, to match the server's timestamps). */
export function recordLastUsed(id: string): void {
  try {
    const all = readAll();
    all[id] = Math.floor(Date.now() / 1000);
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // storage unavailable — passive status just won't persist; not fatal.
  }
}
