/**
 * The two parses behind the splits library, kept away from the store.
 *
 * `splits.ts` imports zustand, so it cannot be loaded by anything but a bundler.
 * These two functions hold the only decisions in the feature — what a corrupt
 * stored key falls back to, and how a layout is written by hand — so they live
 * here, importing nothing at runtime, and `e2e/split-format-check.mjs` loads this
 * file directly. That is the same arrangement `utils/paneTree.ts` already uses:
 * the shipped module is tested, not a copy of it.
 */

/** One pane of a layout: a name to show, and what to run in it. */
export interface LayoutPane {
  name: string;
  command: string;
}

/**
 * Read a stored library, falling back to the defaults on anything unexpected.
 *
 * A corrupt key must not silently empty someone's presets, and an absent key is
 * not the same thing as an empty one: the first means "never configured" and gets
 * the defaults, the second means "configured to nothing" and is honoured.
 */
export function parseStored<T>(raw: string | null, fallback: T[]): T[] {
  if (raw === null) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * A layout's panes, written one per line as `name = command`.
 *
 * A line with no `=` is a pane with that name and a plain shell, so the simplest
 * useful layout ("shell, logs, containers") needs no punctuation at all. A command
 * may itself contain `=`, so only the first one separates. A line with an empty
 * name is dropped rather than producing a nameless pane.
 */
export function parseLayoutPanes(text: string): LayoutPane[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf('=');
      if (at < 0) return { name: line, command: '' };
      return { name: line.slice(0, at).trim(), command: line.slice(at + 1).trim() };
    })
    .filter((p) => p.name !== '');
}
