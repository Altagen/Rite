/**
 * What a keyboard binding is, and whether an event is one.
 *
 * Imports nothing at runtime so `e2e/shortcut-binding-check.mjs` can load this file
 * directly — the matching rules are the whole engine, and they are the kind of thing
 * that looks obviously right and is quietly wrong on one platform.
 *
 * Bindings are written as text (`Mod+Shift+H`) because that is what a settings table
 * shows, what a user types, and what gets stored. `Mod` is the platform's own
 * command modifier: Cmd on macOS, Ctrl everywhere else. Spelling it once here is how
 * the app stops shipping `Ctrl+F` that accepts Cmd and `Ctrl+W` that does not —
 * which it did, so `Cmd+W` closed nothing on a Mac.
 */

export interface Binding {
  /** The platform command modifier: Cmd on macOS, Ctrl elsewhere. */
  mod: boolean;
  shift: boolean;
  alt: boolean;
  /** A single key, as `KeyboardEvent.key` reports it, compared case-insensitively. */
  key: string;
}

/** The parts of a keyboard event this engine looks at. */
export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

const MODIFIERS = new Set(['mod', 'shift', 'alt']);

/**
 * Parse `Mod+Shift+H` into a binding, or null if it is not one.
 *
 * Null rather than a thrown error or a half-binding: this parses stored text and
 * user input, and both can be anything. A caller that gets null falls back to the
 * default, which is the only safe answer — a binding that silently matches nothing
 * is indistinguishable from a broken keyboard.
 */
export function parseBinding(text: string): Binding | null {
  const parts = text.split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  const binding: Binding = { mod: false, shift: false, alt: false, key: '' };
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (MODIFIERS.has(lower)) {
      binding[lower as 'mod' | 'shift' | 'alt'] = true;
      continue;
    }
    // Anything that is not a modifier is the key, and there can be only one.
    if (binding.key !== '') return null;
    binding.key = part;
  }
  return binding.key === '' ? null : binding;
}

/** Canonical text for a binding: modifiers in a fixed order, so two spellings of the
 *  same chord compare equal and a conflict is visible rather than merely present. */
export function formatBinding(binding: Binding): string {
  const parts: string[] = [];
  if (binding.mod) parts.push('Mod');
  if (binding.shift) parts.push('Shift');
  if (binding.alt) parts.push('Alt');
  parts.push(binding.key.length === 1 ? binding.key.toUpperCase() : binding.key);
  return parts.join('+');
}

/** How a binding reads on this platform — what the settings table and tooltips show. */
export function displayBinding(binding: Binding, isMac: boolean): string {
  return formatBinding(binding).replace('Mod', isMac ? 'Cmd' : 'Ctrl');
}

/**
 * Does this event fire this binding?
 *
 * Every modifier is checked, including the ones the binding does *not* ask for: a
 * binding of `Mod+W` must not fire on `Mod+Shift+W`, or a shortcut the user remapped
 * away still goes off. The modifier the platform does not use for `Mod` is required
 * to be absent too, so `Ctrl+W` on a Mac is not quietly `Cmd+W`.
 */
export function matchesBinding(event: KeyEventLike, binding: Binding, isMac: boolean): boolean {
  const mod = isMac ? event.metaKey : event.ctrlKey;
  const otherMod = isMac ? event.ctrlKey : event.metaKey;
  if (mod !== binding.mod) return false;
  if (otherMod) return false;
  if (event.shiftKey !== binding.shift) return false;
  if (event.altKey !== binding.alt) return false;
  // Shift changes what `key` reports ('h' becomes 'H'), and so does the layout for
  // some keys, so the comparison is case-insensitive in both directions.
  return event.key.toLowerCase() === binding.key.toLowerCase();
}

/**
 * Which bindings are claimed by more than one command.
 *
 * Returns the canonical text of each clashing chord. A conflict is not an error —
 * the user is allowed to save one and fix it later — but it must be *shown*, because
 * the alternative is one of the two commands silently never firing.
 */
export function findConflicts(bindings: Record<string, Binding>): string[] {
  const seen = new Map<string, number>();
  for (const binding of Object.values(bindings)) {
    const text = formatBinding(binding);
    seen.set(text, (seen.get(text) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([text]) => text);
}

/**
 * The binding a key event would make, or null if it is not a usable chord.
 *
 * Used by the settings table while recording: pressing only a modifier is not a
 * binding, and neither is a bare letter — a shortcut with no modifier would swallow
 * typing in every terminal in the app.
 */
export function bindingFromEvent(event: KeyEventLike, isMac: boolean): Binding | null {
  const key = event.key;
  if (key === 'Control' || key === 'Meta' || key === 'Shift' || key === 'Alt') return null;
  const binding: Binding = {
    mod: isMac ? event.metaKey : event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
    key,
  };
  if (!binding.mod && !binding.alt) return null;
  return binding;
}
