/**
 * The resolved bindings: the defaults, with the user's remaps on top.
 *
 * Only the overrides are stored, never the full table. A default that changes — as
 * the vertical split just did, off a chord that is paste in three Linux terminals —
 * then reaches everyone who never touched it, instead of being frozen into their
 * settings the first time they opened this screen.
 */
import { create } from 'zustand';
import { parseBinding, formatBinding, type Binding } from './binding';
import { SHORTCUT_COMMANDS } from './commands';

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
    if (!binding) throw new Error(`malformed default binding for ${command.id}: ${command.defaultBinding}`);
    out[command.id] = binding;
  }
  return out;
}

const KEY = 'rite-shortcuts';

/** macOS wants Cmd where everything else wants Ctrl; decided once, here. */
export const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Stored overrides: command id → binding text. Anything unreadable is ignored
 *  rather than thrown, since a corrupt key must not cost the user every shortcut. */
function readOverrides(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY);
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
    localStorage.setItem(KEY, JSON.stringify(overrides));
  } catch {
    /* storage unavailable — keep it in memory only */
  }
}

/** Defaults with overrides applied. An override that no longer parses is dropped,
 *  so the command falls back to its default rather than to nothing. */
export function resolveBindings(overrides: Record<string, string>): Record<string, Binding> {
  const resolved = defaultBindings();
  for (const [id, text] of Object.entries(overrides)) {
    if (!(id in resolved)) continue; // a command that no longer exists
    const binding = parseBinding(text);
    if (binding) resolved[id] = binding;
  }
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
  const overrides = readOverrides();
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
