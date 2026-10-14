/**
 * The two parses behind the splits library, kept away from the store.
 *
 * `splits.ts` imports zustand, so it cannot be loaded by anything but a bundler.
 * These two functions hold the only decisions in the feature — what a corrupt
 * stored key falls back to, and what counts as a preset — so they live here,
 * importing nothing at runtime, and `e2e/split-format-check.mjs` loads this file
 * directly. That is the same arrangement `utils/paneTree.ts` already uses:
 * the shipped module is tested, not a copy of it.
 */

/**
 * Read a stored library, falling back to the defaults on anything unexpected.
 *
 * A corrupt key must not silently empty someone's presets, and an absent key is
 * not the same thing as an empty one: the first means "never configured" and gets
 * the defaults, the second means "configured to nothing" and is honoured.
 *
 * `keep` decides what an entry has to look like, and entries that fail it are
 * dropped rather than failing the whole key — one bad row should cost one row.
 * Guarding the JSON and not the shape was half a guard: `["nope"]` parses, reaches
 * the split menu as a preset, and `preset.id` on a string renders nothing while
 * `preset.name` on `null` takes the window down. What is in this key is per-device
 * and written by the app, so this is not about an attacker; it is about a key that
 * survives a refactor, a half-finished hand edit, or a version that spelled a
 * field differently.
 */
export function parseStored<T>(raw: string | null, fallback: T[], keep?: (entry: unknown) => boolean): T[] {
  if (raw === null) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallback;
    return (keep ? parsed.filter(keep) : parsed) as T[];
  } catch {
    return fallback;
  }
}

/** A string field that is actually a string, and not the empty one. */
const named = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/**
 * Is this a preset? A name, and a command that is a string — the empty command is
 * the plain shell and is meaningful, so it is allowed; a missing one is not.
 */
export function isPreset(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const e = entry as Record<string, unknown>;
  return named(e.id) && named(e.name) && typeof e.command === 'string';
}

