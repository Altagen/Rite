/**
 * Bind a handler to a command, by id.
 *
 * A component says *which command* it implements, never which keys — so remapping is
 * a table edit and no component has an opinion about Ctrl versus Cmd. The listener
 * runs in the capture phase because xterm claims most of the keyboard, and it is
 * registered per command rather than per component so two components implementing
 * two commands do not fight over one handler.
 */
import { useEffect } from 'react';
import { matchesBinding, displayBinding } from './binding';
import { useShortcuts, IS_MAC } from './store';

export function useShortcut(
  commandId: string,
  handler: (event: KeyboardEvent) => void,
  enabled = true,
) {
  const binding = useShortcuts((s) => s.bindings[commandId]);

  useEffect(() => {
    if (!enabled || !binding) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!matchesBinding(event, binding, IS_MAC)) return;
      // A held key repeats; a command should not. Callers that want repeat can read
      // `event.repeat` themselves, but none do, and the one that used to check it
      // did so after already preventing the default.
      if (event.repeat) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      handler(event);
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [binding, enabled, handler]);
}

/**
 * How this command's chord reads on this platform — for a tooltip or a menu label.
 *
 * Here because a tooltip that spells a chord by hand is a second opinion about the
 * keyboard, and the app had three of them: `Split vertical (Ctrl+Shift+V)` survived
 * the default moving off that chord, so the button told the user a key that no
 * longer did anything. Reading it from the same store that dispatches the command
 * means a remap updates the tooltip, and a changed default cannot leave one behind.
 */
export function useBindingText(commandId: string): string {
  const binding = useShortcuts((s) => s.bindings[commandId]);
  return binding ? displayBinding(binding, IS_MAC) : '';
}
