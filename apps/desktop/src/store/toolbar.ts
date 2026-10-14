/**
 * Which buttons the toolbar shows.
 *
 * The toolbar is the one row of the app everyone sees all day, and the right contents
 * differ per person: someone who opens one-off connections all day and someone who
 * only opens saved machines do not want the same row.
 *
 * Hiding is all this does. A hidden button grants nothing and revokes nothing — the
 * keyboard shortcut still works, the menu still reaches it, and a capability the
 * server forbids (Quick SSH, ADR 0017) stays forbidden whatever is set here. That
 * distinction is the whole reason this is a view preference and not a policy: if
 * hiding a button could change what you are allowed to do, it would belong in the
 * server's hands, not the person's.
 *
 * Per device, in localStorage, like the splits library: it describes this window, not
 * the vault, and a vault carried to another computer should not rearrange its UI.
 */

import { create } from 'zustand';

export interface ToolbarPrefs {
  /** The shell dropdown beside New Terminal. */
  shellPicker: boolean;
  /** The focus-mode button (native shell only). F11 works either way. */
  focusMode: boolean;
  quickSsh: boolean;
  /** The Layouts button in the tab strip. It still hides itself with no layouts. */
  layouts: boolean;
}

export const TOOLBAR_DEFAULTS: ToolbarPrefs = {
  shellPicker: true,
  focusMode: true,
  quickSsh: true,
  layouts: true,
};

const KEY = 'rite-toolbar';

/** Only the keys we know, only booleans: anything else in storage is ignored. */
export function acceptedPrefs(stored: unknown): ToolbarPrefs {
  const out = { ...TOOLBAR_DEFAULTS };
  if (!stored || typeof stored !== 'object') return out;
  for (const key of Object.keys(TOOLBAR_DEFAULTS) as (keyof ToolbarPrefs)[]) {
    const value = (stored as Record<string, unknown>)[key];
    if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

function read(): ToolbarPrefs {
  try {
    return acceptedPrefs(JSON.parse(localStorage.getItem(KEY) ?? 'null'));
  } catch {
    return { ...TOOLBAR_DEFAULTS };
  }
}

interface ToolbarState extends ToolbarPrefs {
  set: (key: keyof ToolbarPrefs, value: boolean) => void;
  reset: () => void;
}

export const useToolbar = create<ToolbarState>((set) => ({
  ...read(),
  set: (key, value) =>
    set((s) => {
      const next = { ...pick(s), [key]: value };
      write(next);
      return next;
    }),
  reset: () => {
    write(TOOLBAR_DEFAULTS);
    return set({ ...TOOLBAR_DEFAULTS });
  },
}));

function pick(s: ToolbarPrefs): ToolbarPrefs {
  return {
    shellPicker: s.shellPicker,
    focusMode: s.focusMode,
    quickSsh: s.quickSsh,
    layouts: s.layouts,
  };
}

function write(prefs: ToolbarPrefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable — keep it in memory only */
  }
}
