/**
 * The shells Rite looks for, and which of them this computer has.
 *
 * One list, because there are two places that offer the choice — the toolbar picker
 * and Settings ▸ Terminals — and they are the same setting (`default_shell`). They
 * drifted apart once already: the toolbar listed what was installed while the
 * preferences asked you to type a path, which is how the worse editor ended up being
 * the one in the preferences.
 */

import { Backend } from './backend';

export interface ShellChoice {
  name: string;
  path: string;
  icon: string;
}

export const SHELL_CANDIDATES: ShellChoice[] = [
  { name: 'fish', path: '/usr/bin/fish', icon: '🐠' },
  { name: 'bash', path: '/usr/bin/bash', icon: '🐚' },
  { name: 'zsh', path: '/usr/bin/zsh', icon: '⚡' },
  { name: 'sh', path: '/usr/bin/sh', icon: '📜' },
];

/**
 * The candidates this computer actually has.
 *
 * A failed probe returns every candidate rather than none: offering a shell that
 * turns out to be missing is a clear error when you pick it, while offering nothing
 * looks like the feature is broken.
 */
export async function installedShells(): Promise<ShellChoice[]> {
  try {
    const found = await Backend.Terminal.getInstalledShells(SHELL_CANDIDATES.map((s) => s.path));
    const present = SHELL_CANDIDATES.filter((s) => found.includes(s.path));
    return present.length > 0 ? present : SHELL_CANDIDATES;
  } catch {
    return SHELL_CANDIDATES;
  }
}
