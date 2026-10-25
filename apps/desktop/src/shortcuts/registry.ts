/**
 * What can run right now, and how to run it.
 *
 * THE PROBLEM THIS SOLVES. `useShortcut(id, handler, enabled)` has one declaration point
 * per command, and the handler lives in whichever component implements it — a pane command
 * in `TerminalManager`, the vault lock in `Workspace`. That is the right shape for a
 * keyboard: a component says which command it implements and never which keys. But it
 * leaves no way to run a command from anywhere else, which is exactly what a palette is.
 *
 * So the same declaration also registers the handler here. One change in `useShortcut`,
 * and every command the app already has becomes runnable from a palette, a menu or a
 * button, with no per-component work and no second dispatch table to drift.
 *
 * AND IT ANSWERS AVAILABILITY FOR FREE, which is the part worth having. A command is
 * registered only while a mounted component is implementing it AND its `enabled` is true —
 * so a pane command with no pane focused is not greyed out in the palette, it is absent.
 * A disabled row teaches nothing: it says "not now" without saying why or what instead.
 *
 * Registration is keyed by command id, not by component. Two components implementing the
 * same command would overwrite each other here exactly as they already fight over the
 * chord, so this adds no new failure — and the id is unique per command by construction.
 */
import { create } from 'zustand';

type Handler = (event?: KeyboardEvent) => void;

interface RegistryState {
  /** Command id → the handler of whatever is implementing it at this moment. */
  handlers: Record<string, Handler>;
  register: (id: string, handler: Handler) => void;
  unregister: (id: string) => void;
}

export const useCommandRegistry = create<RegistryState>((set) => ({
  handlers: {},
  register: (id, handler) =>
    set((s) => ({ handlers: { ...s.handlers, [id]: handler } })),
  unregister: (id) =>
    set((s) => {
      // Rebuilt without the key rather than set to undefined: `Object.keys` is what the
      // palette lists from, and a key holding undefined would list a command that cannot
      // run — the one thing this registry exists to prevent.
      const { [id]: _gone, ...rest } = s.handlers;
      return { handlers: rest };
    }),
}));

/**
 * Run a command by id. Returns false when nothing is implementing it.
 *
 * The caller decides what to do about that; the palette never offers one, because it lists
 * from the same record. A false here means something got out of step, not that the user
 * asked for the impossible.
 */
export function runCommand(id: string, event?: KeyboardEvent): boolean {
  const handler = useCommandRegistry.getState().handlers[id];
  if (!handler) return false;
  handler(event);
  return true;
}
