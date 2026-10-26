/**
 * The workspace, as the app sees it (ADR 0023, amended by ADR 0027).
 *
 * One document holds both features that describe a setup: the split menu's `[[preset]]`
 * library and the `[[layout]]` that opens in the morning. It sits on one of two supports:
 *
 * - a **file** on this machine — `GET`/`PUT /api/layouts`, the server picks the path;
 * - the **account**, as a blob sealed under the user's key — `GET`/`PUT /api/user/layouts`,
 *   which the server stores and cannot read.
 *
 * `layoutsVerdict` picks, and `available` is how the rest of the app asks. Unavailable now
 * means one of three things — the instance refused, the reader turned it off, or there is
 * no support to read — and `verdict` says which, so the editor can explain rather than
 * vanish.
 *
 * The parsed contents and the raw text are both kept. The text is what you edit; the
 * presets and layouts are what the menus offer. A document that fails to parse leaves both
 * ALONE — a typo must not empty the menu you were using — and only sets `error`.
 */

import { create } from 'zustand';
import { Backend } from '../utils/backend';
import { deviceStore } from '../utils/deviceStore';
import { isNativeShell } from '../utils/nativeShell';
import { useServerSession } from './serverSessionStore';
import { encryptString, decryptString } from '../utils/vaultCrypto';
import { layoutsVerdict, type LayoutsSupport, type LayoutsVerdict } from '../utils/layoutsPolicy';
import {
  parseLayoutFile,
  formatLayoutFile,
  replacePresetBlocks,
  setLayoutStartup,
  type Layout,
  type LayoutError,
  type Preset,
  type FileCopyMode,
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
// Deliberately `localStorage` and not `deviceStore`: these keys were written by the
// release candidate, in localStorage, before preferences moved to a file the shell owns.
// The carry-over has to read where the old build wrote.
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

/**
 * The two switches the reader owns (ADR 0027 gates 2 and 3), both in `deviceStore`.
 *
 * `enabled` is the reader's: no layouts opening things for them, without asking an admin.
 * `source` is the machine's: *does this one have a workspace of its own*. In the account it
 * would mean switching the laptop switched the desktop too, which is what it exists to
 * avoid — so it is a device preference even though everything beside it is on the account.
 */
const ENABLED_KEY = 'rite.layouts.enabled';
const SOURCE_KEY = 'rite.layouts.source';

export function readEnabled(): boolean {
  return deviceStore.getItem(ENABLED_KEY) !== 'off';
}

/** Default `account`: two machines on one account then agree with nothing configured, and
 *  divergence is the deliberate act rather than sameness. */
export function readSource(): LayoutsSupport {
  return deviceStore.getItem(SOURCE_KEY) === 'file' ? 'file' : 'account';
}

/**
 * Has a startup layout already opened in this browser session (ADR 0027)?
 *
 * `sessionStorage`, not `deviceStore`: the question is about this sitting, not this
 * machine. In the desktop shell the loopback port is new on every launch, so the store is
 * empty there and a relaunch honours startup as it always did.
 */
const STARTUP_KEY = 'rite.layouts.startupRan';

export function startupAlreadyRan(): boolean {
  try {
    return sessionStorage.getItem(STARTUP_KEY) === '1';
  } catch {
    return false;
  }
}

export function markStartupRan(): void {
  try {
    sessionStorage.setItem(STARTUP_KEY, '1');
  } catch {
    /* no session storage: startup runs once per mount, as it did before */
  }
}

/** Seal and unseal with the same primitives as the library tree (ADR 0016): the text is
 *  the payload, so a blob written here is a file written there and back. */
async function unseal(key: Uint8Array, blob: string): Promise<string> {
  return new TextDecoder().decode(await decryptString(key, blob));
}

function seal(key: Uint8Array, text: string): Promise<string> {
  return encryptString(key, new TextEncoder().encode(text));
}

interface LayoutsState {
  /** The document's text, exactly as stored. */
  text: string;
  /** Where the text lives, so it can be edited by hand too. Null on the account: there
   *  is no path, only a row. */
  path: string | null;
  /** Is there a workspace to read and write here, right now? */
  available: boolean;
  /**
   * Could there be one — i.e. does the section belong in Settings at all?
   *
   * Not the same question as `available`, and the difference is a dead end: the reader's
   * own switch lives inside that section, so hiding it when they turn the feature off
   * would hide the way back on. True when only the reader said no; false when the
   * instance refused, or when nothing answered.
   */
  supported: boolean;
  /** Why not, when not — the instance, the reader, or nothing to read (ADR 0027). */
  verdict: LayoutsVerdict | null;
  /** Which support answered. Null while unavailable. */
  support: LayoutsSupport | null;
  /** When the account's row was last written, by this machine or another one. Null on
   *  the file path, where the machine is the only writer. */
  updatedAt: number | null;
  /** The reader's switch, and this machine's choice of support. */
  enabled: boolean;
  prefer: LayoutsSupport;
  /** What the split menu offers, falling back to the shipped two when the file says
   *  nothing at all. */
  presets: Preset[];
  layouts: Layout[];
  /**
   * The copy/paste convention the document asks for, or `null` when it says nothing.
   *
   * `null` and not the default, deliberately: a document that is silent must not look
   * like one that chose the shipped default, or changing that default would stop reaching
   * anyone whose file had ever been read. The terminal applies its own default when this
   * is null (ADR 0023, addendum).
   */
  copyMode: FileCopyMode | null;
  error: LayoutError | null;
  loaded: boolean;
  /** Re-read the file. */
  load: () => Promise<void>;
  /** Write it back, then re-parse. Returns the parse error, if any. */
  save: (text: string) => Promise<LayoutError | null>;
  /** Rewrite just the `[[preset]]` blocks, leaving the rest of the file as typed. */
  savePresets: (presets: Preset[]) => Promise<void>;
  /** Turn one layout's `startup` on or off, by its position in the file. */
  setStartup: (index: number, startup: boolean) => Promise<void>;
  /** Flip the reader's switch, then re-read. */
  setEnabled: (enabled: boolean) => Promise<void>;
  /** Flip this machine's support, then re-read. Switching away from the account does not
   *  delete its copy: switching back finds it where it was (ADR 0027). */
  setPrefer: (prefer: LayoutsSupport) => Promise<void>;
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
  supported: false,
  verdict: null,
  support: null,
  updatedAt: null,
  enabled: readEnabled(),
  prefer: readSource(),
  presets: [],
  layouts: [],
  copyMode: null,
  error: null,
  loaded: false,

  load: async () => {
    const enabled = readEnabled();
    const prefer = readSource();
    const { mode, userKey } = useServerSession.getState();
    const verdict = layoutsVerdict({
      mode,
      userWants: enabled,
      prefer,
      native: isNativeShell(),
    });
    const off = {
      available: false,
      // The reader's own "off" keeps the section: that is where the switch is.
      supported: !verdict.allowed && verdict.by === 'you',
      support: null,
      updatedAt: null,
      presets: [],
      layouts: [],
      error: null,
      loaded: true,
      enabled,
      prefer,
      verdict,
    };
    if (!verdict.allowed) {
      set(off);
      return;
    }

    try {
      // The account's support waits for the key: the blob is sealed under it, and a
      // locked session has nothing to unseal with. The reader signing in re-runs this.
      if (verdict.support === 'account') {
        if (!userKey) {
          set({ ...off, supported: false });
          return;
        }
        const row = await Backend.UserLayouts.get();
        const text = row.blob ? await unseal(userKey, row.blob) : '';
        const parse = parseLayoutFile(text);
        set({
          text,
          path: null,
          available: true,
          supported: true,
          support: 'account',
          updatedAt: row.updatedAt,
          presets: parse.error ? get().presets : resolvePresets(parse),
          layouts: parse.error ? get().layouts : parse.layouts,
          copyMode: parse.error ? get().copyMode : (parse.terminal.copyMode ?? null),
          error: parse.error,
          loaded: true,
          enabled,
          prefer,
          verdict,
        });
        return;
      }

      const file = await Backend.Layouts.get();
      // No file is not an error and not an empty file: there is no support here.
      if (file.text === null) {
        set({ ...off, supported: false });
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
        supported: true,
        support: 'file',
        updatedAt: null,
        // Same rule as save(): a file that does not parse does not empty the menu.
        presets: parse.error ? get().presets : resolvePresets(parse),
        layouts: parse.error ? get().layouts : parse.layouts,
        copyMode: parse.error ? get().copyMode : (parse.terminal.copyMode ?? null),
        error: parse.error,
        loaded: true,
        enabled,
        prefer,
        verdict,
      });
    } catch (error) {
      // An older server has neither endpoint; the buttons hide themselves and nothing
      // else in the app depends on this.
      console.warn('[layouts] could not read the workspace:', error);
      set({ ...off, supported: false, verdict: null });
    }
  },

  setEnabled: async (enabled: boolean) => {
    deviceStore.setItem(ENABLED_KEY, enabled ? 'on' : 'off');
    set({ enabled });
    await get().load();
  },

  setPrefer: async (prefer: LayoutsSupport) => {
    deviceStore.setItem(SOURCE_KEY, prefer);
    set({ prefer });
    await get().load();
  },

  savePresets: async (presets: Preset[]) => {
    await get().save(replacePresetBlocks(get().text, presets));
  },

  // By position, because that is what the file has: `Layout.id` is assigned by the
  // parse (`l1`, `l2`, …) and means nothing to the document.
  setStartup: async (index: number, startup: boolean) => {
    await get().save(setLayoutStartup(get().text, index, startup));
  },

  save: async (text: string) => {
    const parse = parseLayoutFile(text);
    // The text is saved even when it does not parse: it is the user's document, and
    // refusing to store it would mean losing the half-finished edit they asked us
    // to keep. What a bad document does not do is replace the layouts already loaded.
    if (get().support === 'account') {
      const { userKey } = useServerSession.getState();
      if (!userKey) throw new Error('layouts: no key to seal with');
      await Backend.UserLayouts.set(await seal(userKey, text));
    } else {
      await Backend.Layouts.put(text);
    }
    set({
      text,
      presets: parse.error ? get().presets : resolvePresets(parse),
      layouts: parse.error ? get().layouts : parse.layouts,
      copyMode: parse.error ? get().copyMode : (parse.terminal.copyMode ?? null),
      error: parse.error,
    });
    return parse.error;
  },
}));
