/**
 * The keyboard table: every command, what fires it, and how to change that.
 *
 * Recording rather than typing. A text field for a chord asks people to know that
 * `Mod` means Cmd here and Ctrl there, and to spell the key the way the browser
 * reports it — so the row listens for the keypress instead and shows what it heard.
 *
 * Three things the table has to say out loud, because each one is silent otherwise:
 * a chord claimed by two commands (one of them simply never fires), a chord the
 * terminal needs for itself (paste, which a default used to steal), and whether a
 * row still carries its default.
 */

import { useEffect, useState } from 'react';
import {
  displayBinding,
  bindingFromEvent,
  formatBinding,
  findConflicts,
  parseBinding,
} from '../shortcuts/binding';
import { SHORTCUT_COMMANDS, isReservedText } from '../shortcuts/commands';
import { useShortcuts, IS_MAC } from '../shortcuts/store';

export function ShortcutsSettings() {
  const { bindings, overrides, rebind, reset, resetAll } = useShortcuts();
  const [recording, setRecording] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);

  const conflicts = findConflicts(bindings);

  // While a row is recording it owns the keyboard, in the capture phase, so the
  // chord being assigned cannot also fire the command it is currently bound to.
  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === 'Escape') {
        setRecording(null);
        setRefused(null);
        return;
      }

      const binding = bindingFromEvent(event, IS_MAC);
      if (!binding) return; // a modifier on its own, or a bare letter — keep listening

      const text = formatBinding(binding);
      if (isReservedText(text)) {
        // Refused rather than accepted-and-broken: this is the terminal's own chord.
        setRefused(`${displayBinding(binding, IS_MAC)} belongs to the terminal — it is copy or paste.`);
        return;
      }

      rebind(recording, binding);
      setRecording(null);
      setRefused(null);
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [recording, rebind]);

  const anyOverride = Object.keys(overrides).length > 0;

  return (
    <div>
      <div className="mb-3 flex items-start justify-between gap-4">
        <p className="text-xs text-muted-foreground">
          Click a shortcut, then press the keys you want. {IS_MAC ? 'Cmd' : 'Ctrl'} is the command
          modifier on this machine, and the same binding follows you to the other.
        </p>
        {anyOverride && (
          <button
            type="button"
            onClick={() => resetAll()}
            className="flex-none rounded border border-border px-2 py-1 text-xs hover:bg-muted"
            data-testid="shortcuts-reset-all"
          >
            Reset all
          </button>
        )}
      </div>

      <ul className="flex flex-col gap-1.5">
        {SHORTCUT_COMMANDS.map((command) => {
          const binding = bindings[command.id];
          if (!binding) return null;
          const text = formatBinding(binding);
          const clashes = conflicts.includes(text);
          const isRecording = recording === command.id;
          const overridden = command.id in overrides;

          return (
            <li
              key={command.id}
              className="flex items-center gap-3 rounded border border-border bg-muted/40 px-2.5 py-1.5"
              data-testid={`shortcut-row-${command.id}`}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{command.label}</div>
                <div className="truncate text-[11px] text-muted-foreground">{command.description}</div>
              </div>

              {clashes && (
                <span
                  className="flex-none rounded border border-amber-500/50 px-1.5 text-[10px] font-semibold text-amber-500"
                  title="Another command uses this chord, so one of the two never fires."
                  data-testid={`shortcut-conflict-${command.id}`}
                >
                  conflict
                </span>
              )}

              <button
                type="button"
                onClick={() => {
                  setRefused(null);
                  setRecording(isRecording ? null : command.id);
                }}
                className={`flex-none rounded border px-2 py-0.5 font-mono text-xs ${
                  isRecording
                    ? 'border-primary text-primary'
                    : 'border-border hover:bg-muted'
                }`}
                data-testid={`shortcut-binding-${command.id}`}
              >
                {isRecording ? 'press keys…' : displayBinding(binding, IS_MAC)}
              </button>

              {overridden && (
                <button
                  type="button"
                  onClick={() => reset(command.id)}
                  className="flex-none rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                  title={`Back to ${displayBinding(parseBinding(command.defaultBinding)!, IS_MAC)}`}
                  data-testid={`shortcut-reset-${command.id}`}
                >
                  ↺
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {refused && <p className="mt-2 text-xs text-amber-500">{refused}</p>}
      {conflicts.length > 0 && (
        <p className="mt-2 text-xs text-amber-500">
          Two commands share a chord. Both are saved, but only one of them will fire.
        </p>
      )}
    </div>
  );
}
