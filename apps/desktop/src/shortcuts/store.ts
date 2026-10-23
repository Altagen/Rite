/**
 * The resolved bindings: the defaults, with the user's remaps on top.
 *
 * Only the overrides are stored, never the full table. A default that changes — as
 * the vertical split just did, off a chord that is paste in three Linux terminals —
 * then reaches everyone who never touched it, instead of being frozen into their
 * settings the first time they opened this screen.
 */
import { deviceStore } from '../utils/deviceStore';
import { create } from 'zustand';
import { parseBinding, formatBinding, type Binding } from './binding';
import { SHORTCUT_COMMANDS, isReservedText } from './commands';

/**
 * The defaults as parsed bindings.
 *
 * Here rather than in `commands.ts` because it needs both the table and the parser,
 * and `commands.ts` stays importless so a standalone check can load it. A malformed
 * default is a bug in this repository, not in anyone's settings, so it throws.
 */
export function defaultBindings(): Record<string, Binding> {
  const out: Record<string, Binding> = {};
  for (const command of SHORTCUT_COMMANDS) {
    const binding = parseBinding(command.defaultBinding);
    if (!binding)
      throw new Error(`malformed default binding for ${command.id}: ${command.defaultBinding}`);
    out[command.id] = binding;
  }
  return out;
}

const KEY = 'rite-shortcuts';

/** macOS wants Cmd where everything else wants Ctrl; decided once, here. */
export const IS_MAC =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Stored overrides: command id → binding text. Anything unreadable is ignored
 *  rather than thrown, since a corrupt key must not cost the user every shortcut. */
function readOverrides(): Record<string, string> {
  try {
    const raw = deviceStore.getItem(KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [id, text] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof text === 'string') out[id] = text;
    }
    return out;
  } catch {
    return {};
  }
}

function writeOverrides(overrides: Record<string, string>) {
  try {
    deviceStore.setItem(KEY, JSON.stringify(overrides));
  } catch {
    /* storage unavailable — keep it in memory only */
  }
}

/**
 * The overrides that survive, as bindings. One gate, three ways to fail it:
 *
 *   * a command that no longer exists — a stored id outlives a rename;
 *   * text that no longer parses;
 *   * a chord the terminal needs for itself. The settings table already refuses
 *     those, so an override can only hold one if it predates the refusal — and that
 *     is exactly what happens the next time the reserved list grows: whoever had
 *     taken the chord would keep it, and would be the one user who cannot paste and
 *     cannot explain why. The list belongs where the bindings are decided, not only
 *     where they are typed.
 *
 * Both of the functions below read this one, so there is no second copy of the rule
 * to fall behind — and no branch that only one of them exercises.
 */
function accepted(overrides: Record<string, string>): Map<string, Binding> {
  const known = defaultBindings();
  const out = new Map<string, Binding>();
  for (const [id, text] of Object.entries(overrides)) {
    if (!(id in known)) continue;
    const binding = parseBinding(text);
    if (!binding) continue;
    if (isReservedText(formatBinding(binding))) continue;
    out.set(id, binding);
  }
  return out;
}

/**
 * The overrides worth storing, canonically spelled.
 *
 * Dropping the rest changes no binding — `resolveBindings` ignores them either way.
 * It changes what is *stored*, and therefore what the settings table is allowed to
 * say: a row shows a reset arrow when an override exists, and an override that is
 * ignored would put that arrow beside a binding that is the default. Dead data has
 * to be removed rather than explained.
 */
export function pruneOverrides(overrides: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, binding] of accepted(overrides)) out[id] = formatBinding(binding);
  return out;
}

/** Defaults with the surviving overrides applied. */
export function resolveBindings(overrides: Record<string, string>): Record<string, Binding> {
  const resolved = defaultBindings();
  for (const [id, binding] of accepted(overrides)) resolved[id] = binding;
  return resolved;
}

interface ShortcutsState {
  overrides: Record<string, string>;
  bindings: Record<string, Binding>;
  /** Remap one command. */
  rebind: (id: string, binding: Binding) => void;
  /** Drop one override, returning that command to its default. */
  reset: (id: string) => void;
  /** Drop every override. */
  resetAll: () => void;
}

export const useShortcuts = create<ShortcutsState>((set) => {
  const stored = readOverrides();
  const overrides = pruneOverrides(stored);
  // Written back only when something was actually dropped, so a normal start does
  // not touch storage.
  if (Object.keys(overrides).length !== Object.keys(stored).length) writeOverrides(overrides);
  return {
    overrides,
    bindings: resolveBindings(overrides),
    rebind: (id, binding) =>
      set((s) => {
        const next = { ...s.overrides, [id]: formatBinding(binding) };
        writeOverrides(next);
        return { overrides: next, bindings: resolveBindings(next) };
      }),
    reset: (id) =>
      set((s) => {
        const next = { ...s.overrides };
        delete next[id];
        writeOverrides(next);
        return { overrides: next, bindings: resolveBindings(next) };
      }),
    resetAll: () =>
      set(() => {
        writeOverrides({});
        return { overrides: {}, bindings: resolveBindings({}) };
      }),
  };
});
