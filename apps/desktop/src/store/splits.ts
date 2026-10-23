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
 * They used to live in this device's localStorage, which is per-browser and
 * invisible. They are `[[preset]]` in the workspace file now, beside the layouts —
 * one documented format for the whole of "how this machine is set up" (ADR 0023,
 * docs/LAYOUTS.md). This module is what is left: the shape, the plain split, and the
 * three edits the dialog makes, each of which rewrites only the preset blocks of the
 * file and leaves everything else as it was typed.
 */
import { useLayouts } from './layouts';
import type { Preset } from './layoutsFormat';

/** One pane a split can open: a name to show, and the command to run in it. */
export type SplitPreset = Preset;

/** The plain split, always present and never removable: it is what the button does. */
export const PLAIN_PRESET: SplitPreset = { id: 'plain', name: 'Terminal', command: '' };

const newId = (p: string) => `${p}-${Math.random().toString(36).slice(2, 9)}`;

export function useSplits() {
  const presets = useLayouts((s) => s.presets);
  const savePresets = useLayouts((s) => s.savePresets);

  // Fire and forget: the store already holds the new library, and the file write is
  // the same PUT the editor uses. A failed write leaves the dialog showing what it
  // asked for and logs — there is nothing the list itself could do about it.
  const write = (next: SplitPreset[]) => {
    void savePresets(next);
  };

  return {
    presets,
    addPreset: (name: string, command: string) =>
      write([...presets, { id: newId('sp'), name, command }]),
    /** Change a preset in place, keeping its id. */
    updatePreset: (id: string, name: string, command: string) =>
      write(presets.map((x) => (x.id === id ? { ...x, name, command } : x))),
    removePreset: (id: string) => write(presets.filter((x) => x.id !== id)),
  };
}
