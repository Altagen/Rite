/**
 * The workspace file, as the app sees it (ADR 0023).
 *
 * One file holds both features that describe this machine's setup: the split menu's
 * `[[preset]]` library and the `[[layout]]` that opens in the morning. The text comes
 * from `GET /api/layouts` and goes back with `PUT`; the server decides where that is,
 * and a shared server answers that there is NO file — presets and layouts are the
 * machine's, not the account's, so there is nothing to show and no substitute to
 * invent. `available` is how the rest of the app asks.
 *
 * The parsed contents and the raw text are both kept. The text is what you edit; the
 * presets and layouts are what the menus offer. A file that fails to parse leaves both
 * ALONE — a typo must not empty the menu you were using — and only sets `error`.
 */

import { create } from 'zustand';
import { Backend } from '../utils/backend';
import {
  parseLayoutFile,
  formatLayoutFile,
  replacePresetBlocks,
  type Layout,
  type LayoutError,
  type Preset,
} from './layoutsFormat';
import { parseStored, isPreset } from './splitsFormat';

/**
 * What ships, for a machine whose file says nothing at all.
 *
 * Both run on a machine with nothing installed on it, which is the whole requirement:
 * a preset that ships broken makes someone understand the feature before they can work
 * out why it did nothing. `watch -n2 docker ps` was here and is gone, because it only
 * works for people who have Docker.
 *
 * They are a fallback, not a seed: a file that declares a layout but no preset is a
 * file somebody wrote, and it is honoured as it is. The first edit in the dialog writes
 * them into the file, where they become visible and editable like any other row.
 */
export const DEFAULT_PRESETS: Preset[] = [
  { id: 'sp-load', name: 'Load', command: 'top' },
  { id: 'sp-disk', name: 'Disk', command: 'df -h' },
];

/**
 * Layouts made before they were a file.
 *
 * The first version of the feature kept them in localStorage, per device. It never
 * shipped in a release, but it did ship in a release candidate, and whoever tried it
 * typed those panes in by hand. Carried over once, the key is then dropped so this
 * cannot fight with the file afterwards.
 */
const LEGACY_KEY = 'rite-split-layouts';
const LEGACY_PRESETS_KEY = 'rite-split-presets';
function readLegacy(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function forgetLegacy(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* nothing to do: the carry-over already happened in memory */
  }
}

export function takeLegacyLayouts(): Layout[] {
  const raw = readLegacy(LEGACY_KEY);
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const layouts: Layout[] = [];
  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      const e = entry as { name?: unknown; panes?: unknown };
      if (typeof e?.name !== 'string' || !Array.isArray(e.panes)) continue;
      const panes = e.panes
        .map((p) => p as { name?: unknown; command?: unknown })
        .filter((p) => typeof p?.command === 'string')
        .map((p) => ({
          command: String(p.command),
          name: typeof p.name === 'string' && p.name.trim() ? String(p.name) : undefined,
        }));
      if (panes.length) {
        layouts.push({ id: `legacy${layouts.length + 1}`, name: e.name, startup: false, panes });
      }
    }
  }
  forgetLegacy(LEGACY_KEY);
  return layouts;
}

/**
 * Presets made before they were in the file — the per-device localStorage library.
 *
 * Read through `parseStored`/`isPreset` rather than trusted: this key survived a
 * refactor and a half-finished hand edit, and one bad row should cost one row.
 */
export function takeLegacyPresets(): Preset[] {
  const raw = readLegacy(LEGACY_PRESETS_KEY);
  if (raw === null) return [];
  const presets = parseStored<Preset>(raw, [], isPreset);
  forgetLegacy(LEGACY_PRESETS_KEY);
  return presets;
}

interface LayoutsState {
  /** The file's text, exactly as stored. */
  text: string;
  /** Where the text lives, so it can be edited by hand too. */
  path: string | null;
  /** Is there a file at all? False on a shared server: no presets, no layouts, no
   *  editor — the features belong to a machine and this is not one (ADR 0023). */
  available: boolean;
  /** What the split menu offers, falling back to the shipped two when the file says
   *  nothing at all. */
  presets: Preset[];
  layouts: Layout[];
  error: LayoutError | null;
  loaded: boolean;
  /** Re-read the file. */
  load: () => Promise<void>;
  /** Write it back, then re-parse. Returns the parse error, if any. */
  save: (text: string) => Promise<LayoutError | null>;
  /** Rewrite just the `[[preset]]` blocks, leaving the rest of the file as typed. */
  savePresets: (presets: Preset[]) => Promise<void>;
}

/** The presets to offer: what the file declares, or the shipped two when the file
 *  declares nothing at all. A file with a layout and no preset is a decision. */
function resolvePresets(parse: { presets: Preset[]; layouts: Layout[] }): Preset[] {
  if (parse.presets.length > 0) return parse.presets;
  return parse.layouts.length > 0 ? [] : DEFAULT_PRESETS;
}

export const useLayouts = create<LayoutsState>((set, get) => ({
  text: '',
  path: null,
  available: false,
  presets: [],
  layouts: [],
  error: null,
  loaded: false,

  load: async () => {
    try {
      const file = await Backend.Layouts.get();
      // No file is not an error and not an empty file: the feature is absent here.
      if (file.text === null) {
        set({ available: false, presets: [], layouts: [], error: null, loaded: true });
        return;
      }
      let parse = parseLayoutFile(file.text);
      let text = file.text;

      // Nothing in the file and something in an old per-device store: carry it over
      // rather than silently dropping what someone typed into the release candidate.
      if (!parse.error && parse.layouts.length === 0 && parse.presets.length === 0) {
        const legacyLayouts = takeLegacyLayouts();
        const legacyPresets = takeLegacyPresets();
        if (legacyLayouts.length || legacyPresets.length) {
          text = formatLayoutFile(legacyLayouts, legacyPresets);
          parse = parseLayoutFile(text);
          await Backend.Layouts.put(text);
        }
      }
      set({
        text,
        path: file.path ?? null,
        available: true,
        // Same rule as save(): a file that does not parse does not empty the menu.
        presets: parse.error ? get().presets : resolvePresets(parse),
        layouts: parse.error ? get().layouts : parse.layouts,
        error: parse.error,
        loaded: true,
      });
    } catch (error) {
      // No file is a legitimate state (an older server has no endpoint); the buttons
      // hide themselves and nothing else in the app depends on this.
      console.warn('[layouts] could not read the workspace file:', error);
      set({ loaded: true });
    }
  },

  savePresets: async (presets: Preset[]) => {
    await get().save(replacePresetBlocks(get().text, presets));
  },

  save: async (text: string) => {
    const parse = parseLayoutFile(text);
    // The text is saved even when it does not parse: it is the user's file, and
    // refusing to store it would mean losing the half-finished edit they asked us
    // to keep. What a bad file does not do is replace the layouts already loaded.
    await Backend.Layouts.put(text);
    set({
      text,
      presets: parse.error ? get().presets : resolvePresets(parse),
      layouts: parse.error ? get().layouts : parse.layouts,
      error: parse.error,
    });
    return parse.error;
  },
}));

/** The layouts marked `startup = true`, in file order. */
export function startupLayouts(layouts: Layout[]): Layout[] {
  return layouts.filter((l) => l.startup);
}
