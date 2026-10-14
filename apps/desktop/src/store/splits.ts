/**
 * Split presets: what a divider can open.
 *
 * Splitting a pane opens a plain terminal — that is the button, and it stays the
 * button, because a plain divider is what most people want and they should not pay
 * for the minority who want `top` on the right.
 *
 * A preset is a name and a command, nothing more: the same divider, running one
 * thing. It is what the chevron beside the button offers.
 *
 * Layouts used to live here too, and that was the mistake. A preset is a reflex you
 * type in four seconds; a layout is what opens when you sit down — it names machines,
 * it has an order, people keep it in version control. It is a file now: see
 * `store/layouts.ts` and docs/LAYOUTS.md.
 *
 * Like snippets, running one only types the command into the new session's stdin, so
 * there is no backend and the library lives per-device in localStorage.
 */
import { create } from 'zustand';
import { parseStored, isPreset } from './splitsFormat';

/** One pane a split can open: a name to show, and the command to run in it. */
export interface SplitPreset {
  id: string;
  name: string;
  /** Empty means a plain shell — the default action, and the one that cannot be deleted. */
  command: string;
}

const PRESETS_KEY = 'rite-split-presets';

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
  addPreset: (name: string, command: string) => void;
  /** Change a preset in place, keeping its id. */
  updatePreset: (id: string, name: string, command: string) => void;
  removePreset: (id: string) => void;
}

export const useSplits = create<SplitsState>((set) => ({
  presets: read(PRESETS_KEY, DEFAULT_PRESETS, isPreset),
  addPreset: (name, command) =>
    set((s) => {
      const next = [...s.presets, { id: newId('sp'), name, command }];
      write(PRESETS_KEY, next);
      return { presets: next };
    }),
  updatePreset: (id, name, command) =>
    set((s) => {
      const next = s.presets.map((x) => (x.id === id ? { ...x, name, command } : x));
      write(PRESETS_KEY, next);
      return { presets: next };
    }),
  removePreset: (id) =>
    set((s) => {
      const next = s.presets.filter((x) => x.id !== id);
      write(PRESETS_KEY, next);
      return { presets: next };
    }),
}));
