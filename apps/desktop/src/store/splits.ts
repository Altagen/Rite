/**
 * Split presets and layouts: what a divider can open.
 *
 * Splitting a pane opens a plain terminal — that is the button, and it stays the
 * button, because a plain divider is what most people want and they should not pay
 * for the minority who want `top` on the right.
 *
 * These are what the chevron beside it offers as well. A **preset** is a name and a
 * command, nothing more. A **layout** opens several at once — the "five terminals
 * arranged like this" case. A layout holds its panes *by value* rather than by
 * preset id, so editing a preset never silently rewrites a layout someone relies on;
 * that is a deliberate copy, not an oversight.
 *
 * Like snippets, running one only types the command into the new session's stdin, so
 * there is no backend and the library lives per-device in localStorage.
 */
import { create } from 'zustand';
import { parseStored, parseLayoutPanes, isPreset, isLayout, type LayoutPane } from './splitsFormat';

export { parseLayoutPanes };
export type { LayoutPane };

/** One pane a split can open: a name to show, and the command to run in it. */
export interface SplitPreset {
  id: string;
  name: string;
  /** Empty means a plain shell — the default action, and the one that cannot be deleted. */
  command: string;
}

export interface SplitLayout {
  id: string;
  name: string;
  /** Copied by value when the layout is saved — see the note above. */
  panes: LayoutPane[];
}

const PRESETS_KEY = 'rite-split-presets';
const LAYOUTS_KEY = 'rite-split-layouts';

/** The plain split, always present and never removable: it is what the button does. */
export const PLAIN_PRESET: SplitPreset = { id: 'plain', name: 'Terminal', command: '' };

/**
 * What ships, for a first run that has nothing configured.
 *
 * Both of these run on a machine with nothing installed on it, which is the whole
 * requirement: a preset that ships broken makes the user understand the feature
 * before they can work out why it did nothing. `watch -n2 docker ps` was here and
 * is gone, because it only works for people who have Docker; anyone who has it can
 * add it in two fields, and anyone who does not would have had a preset that fails.
 * The machine dashboard is the opposite case and is fine: it *detects* a runtime
 * and says so when there is none.
 */
const DEFAULT_PRESETS: SplitPreset[] = [
  { id: 'sp-load', name: 'Load', command: 'top' },
  { id: 'sp-disk', name: 'Disk', command: 'df -h' },
];

const DEFAULT_LAYOUTS: SplitLayout[] = [];

const read = <T>(key: string, fallback: T[], keep: (entry: unknown) => boolean): T[] => {
  try {
    return parseStored(localStorage.getItem(key), fallback, keep);
  } catch {
    return fallback;
  }
};

const write = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable — keep it in memory only */
  }
};

const newId = (p: string) => `${p}-${Math.random().toString(36).slice(2, 9)}`;

interface SplitsState {
  presets: SplitPreset[];
  layouts: SplitLayout[];
  addPreset: (name: string, command: string) => void;
  removePreset: (id: string) => void;
  addLayout: (name: string, panes: LayoutPane[]) => void;
  removeLayout: (id: string) => void;
}

export const useSplits = create<SplitsState>((set) => ({
  presets: read(PRESETS_KEY, DEFAULT_PRESETS, isPreset),
  layouts: read(LAYOUTS_KEY, DEFAULT_LAYOUTS, isLayout),
  addPreset: (name, command) =>
    set((s) => {
      const next = [...s.presets, { id: newId('sp'), name, command }];
      write(PRESETS_KEY, next);
      return { presets: next };
    }),
  removePreset: (id) =>
    set((s) => {
      const next = s.presets.filter((x) => x.id !== id);
      write(PRESETS_KEY, next);
      return { presets: next };
    }),
  addLayout: (name, panes) =>
    set((s) => {
      // Copied here, so a later edit to a preset cannot reach into this layout.
      const next = [...s.layouts, { id: newId('sl'), name, panes: panes.map((p) => ({ ...p })) }];
      write(LAYOUTS_KEY, next);
      return { layouts: next };
    }),
  removeLayout: (id) =>
    set((s) => {
      const next = s.layouts.filter((x) => x.id !== id);
      write(LAYOUTS_KEY, next);
      return { layouts: next };
    }),
}));
