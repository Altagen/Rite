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
  /**
   * `Mod` is Cmd on macOS, Ctrl elsewhere — see binding.ts.
   *
   * Optional, because a command worth running is not always a command worth a chord. An
   * action with no default is still listed by the palette and still assignable a chord in
   * Settings; it simply ships without one. Only a handful of chords can be good, and a
   * table that required one would either invent bad ones or hide the actions.
   */
  defaultBinding?: string;
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
  // Locking is a safety reflex — the thing you do when you stand up — and it had no chord
  // at all while four pane commands did. It needs one now that the button moved into the
  // pastille's menu: a keystroke is better than the single click it replaced, and much
  // better than a click plus an aim. Mod+Shift+L is free in gnome-terminal, konsole and
  // xfce4-terminal, and is not one of the two RESERVED_BINDINGS below.
  { id: 'vault.lock', defaultBinding: 'Mod+Shift+L' },
  // The palette's own chord. `Mod+K` is what every editor uses for this, it is free in
  // gnome-terminal, konsole and xfce4-terminal, and it is not one of RESERVED_BINDINGS.
  // Taken on the window in the capture phase like the rest, because it has to open from
  // inside a terminal — which claims most of the keyboard.
  { id: 'palette.open', defaultBinding: 'Mod+K' },
  // Ships WITHOUT a chord, which is the point of the palette: this is worth finding and
  // not worth one of the few good chords. A person who disagrees can assign one in
  // Settings, where it appears beside the rest.
  { id: 'settings.open' },
  // The cheatsheet. Spelled `?` and not `/`, because the matcher compares `event.key`
  // with the modifiers held and `?` is what both AZERTY (Shift+comma) and US (Shift+/)
  // report — so one default works on both, and naming the cap instead of the key would
  // have shipped a chord that fires on neither.
  { id: 'shortcuts.cheatsheet', defaultBinding: 'Mod+Shift+?' },
];

/** Every command id, whether or not it ships with a chord. */
export const COMMAND_IDS: string[] = SHORTCUT_COMMANDS.map((c) => c.id);

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
