/**
 * The layouts file, as the app sees it.
 *
 * One store for both shells: the text comes from `GET /api/layouts` and goes back
 * with `PUT`, and the server decides where that is — a real file in your config
 * directory on a desktop (so your own editor can edit it too), the instance's
 * settings store on a shared server, which has no file to offer a browser.
 *
 * The parsed layouts and the raw text are both kept. The text is what you edit; the
 * layouts are what the menu offers. A file that fails to parse leaves the layouts
 * ALONE — a typo must not empty the menu you were using — and only sets `error`.
 */

import { create } from 'zustand';
import { Backend } from '../utils/backend';
import { parseLayoutFile, formatLayoutFile, type Layout, type LayoutError } from './layoutsFormat';

/**
 * Layouts made before they were a file.
 *
 * The first version of the feature kept them in localStorage, per device. It never
 * shipped in a release, but it did ship in a release candidate, and whoever tried it
 * typed those panes in by hand. Carried over once, the key is then dropped so this
 * cannot fight with the file afterwards.
 */
const LEGACY_KEY = 'rite-split-layouts';
function readLegacy(): string | null {
  try {
    return localStorage.getItem(LEGACY_KEY);
  } catch {
    return null;
  }
}

export function takeLegacyLayouts(): Layout[] {
  const raw = readLegacy();
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
  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* nothing to do: the carry-over already happened in memory */
  }
  return layouts;
}

interface LayoutsState {
  /** The file's text, exactly as stored. */
  text: string;
  /** Where the text lives, when the user can also edit it by hand. */
  path: string | null;
  layouts: Layout[];
  error: LayoutError | null;
  loaded: boolean;
  /** Re-read the file. */
  load: () => Promise<void>;
  /** Write it back, then re-parse. Returns the parse error, if any. */
  save: (text: string) => Promise<LayoutError | null>;
}

export const useLayouts = create<LayoutsState>((set, get) => ({
  text: '',
  path: null,
  layouts: [],
  error: null,
  loaded: false,

  load: async () => {
    try {
      const file = await Backend.Layouts.get();
      let parse = parseLayoutFile(file.text);
      let text = file.text;

      // Nothing in the file and something in the old per-device store: carry it over
      // rather than silently dropping what someone typed into the release candidate.
      if (!parse.error && parse.layouts.length === 0) {
        const legacy = takeLegacyLayouts();
        if (legacy.length) {
          text = `${formatLayoutFile(legacy)}`;
          parse = parseLayoutFile(text);
          await Backend.Layouts.put(text);
        }
      }
      set({
        text,
        path: file.path ?? null,
        // Same rule as save(): a file that does not parse does not empty the menu.
        layouts: parse.error ? get().layouts : parse.layouts,
        error: parse.error,
        loaded: true,
      });
    } catch (error) {
      // No layouts is a legitimate state (an older server has no endpoint); the
      // button hides itself and nothing else in the app depends on this.
      console.warn('[layouts] could not read the layouts file:', error);
      set({ loaded: true });
    }
  },

  save: async (text: string) => {
    const parse = parseLayoutFile(text);
    // The text is saved even when it does not parse: it is the user's file, and
    // refusing to store it would mean losing the half-finished edit they asked us
    // to keep. What a bad file does not do is replace the layouts already loaded.
    await Backend.Layouts.put(text);
    set({
      text,
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
