/**
 * Every keyboard command the app has, and what it is bound to by default.
 *
 * One table. Before this there were four shortcuts written inline in two components
 * as `if (e.ctrlKey && …)`, which is why `Ctrl+F` accepted Cmd and `Ctrl+W` did not —
 * nothing was comparing them, because there was nowhere to compare them.
 *
 * Imports nothing at all — not even `binding.ts` — so the standalone check can load
 * it beside the matcher and hold these defaults to the rules there. Anything that
 * needs both the table and the parser lives in `store.ts`, which no check loads.
 */

export interface ShortcutCommand {
  /**
   * The command's id, and the stem of its two strings in the locales:
   * `shortcuts.cmd.<id>.label` and `.description`. `t()` splits on dots, so an id
   * like `pane.close` nests the way the rest of the file does. The strings are not
   * here because this module has to import nothing — and because the app has a
   * French locale, and a settings screen in one language is not a settings screen.
   * `e2e/i18n-check.mjs` holds every id below to having both, in both locales.
   */
  id: string;
  /** `Mod` is Cmd on macOS, Ctrl elsewhere — see binding.ts. */
  defaultBinding: string;
}

/**
 * Defaults, and the two that are deliberately not what they used to be:
 *
 *   * every one of them uses `Mod`, so Cmd works on a Mac for all of them rather
 *     than for search alone;
 *   * splitting vertically moved off `Mod+Shift+V`, which is **paste** in
 *     gnome-terminal, konsole and xfce4-terminal. A terminal emulator that steals
 *     paste to split a pane is a terminal emulator people stop using, and we were
 *     about to add copy/paste bindings on top of it. `Mod+Shift+D` is free in those
 *     three and is iTerm2's split, so it is the least surprising replacement.
 *     Anyone who wants the old chord can set it back — that is the point of the
 *     engine — but it cannot be what we ship.
 */
export const SHORTCUT_COMMANDS: ShortcutCommand[] = [
  { id: 'pane.close', defaultBinding: 'Mod+W' },
  { id: 'pane.splitHorizontal', defaultBinding: 'Mod+Shift+H' },
  { id: 'pane.splitVertical', defaultBinding: 'Mod+Shift+D' },
  { id: 'pane.search', defaultBinding: 'Mod+F' },
];

/**
 * Chords the app must not take, whatever the user asks.
 *
 * These are the terminal's own, and a terminal client that eats them is broken in a
 * way no setting excuses. Taking `Mod+Shift+V` is how the old vertical-split default
 * broke paste on three Linux terminals at once.
 */
export const RESERVED_BINDINGS = ['Mod+Shift+C', 'Mod+Shift+V'];

/** Is this chord one the terminal needs for itself? Takes the canonical text, so
 *  this file needs nothing from the matcher to answer. */
export function isReservedText(text: string): boolean {
  return RESERVED_BINDINGS.includes(text);
}
