/**
 * The shortcuts cheatsheet: what the keyboard does, read from the table that does it.
 *
 * A READER, never a second list. This app once told people
 * `Split vertical (Ctrl+Shift+V)` in a tooltip long after the default had moved off that
 * chord, because the label and the dispatcher were two separate opinions about the
 * keyboard. Everything here comes from `useShortcuts`, the same store `useShortcut`
 * dispatches from — so a remap moves it, and a changed default cannot leave a stale chord
 * behind in a second place.
 *
 * IT LISTS EVERYTHING, which is the opposite of the palette's rule and deliberate. The
 * palette lists what can run right now, because offering to run something that cannot run
 * is a dead end. A cheatsheet teaches the keyboard: `Ctrl+W` closes a pane, and that is
 * worth knowing while no pane is open. Filtering by availability would hide the answer at
 * exactly the moment someone went looking for it.
 *
 * Nothing in it runs anything. A row that acted on a click would make this a second
 * palette with different rules, and the palette is one chord away.
 *
 * Mirrors `design/mock/desktop.html`, which got it first (ADR 0019).
 */
import { useEffect } from 'react';
import { useTranslation } from '../i18n/i18n';
import { SHORTCUT_COMMANDS } from '../shortcuts/commands';
import { useShortcuts, IS_MAC } from '../shortcuts/store';
import { displayBinding } from '../shortcuts/binding';

export function ShortcutsCheatsheet({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const bindings = useShortcuts((s) => s.bindings);

  // Escape, on the window. The palette gets this from its input's `onKeyDown`; there is no
  // input here, and a modal that only closes by clicking its own backdrop is a modal
  // people get stuck in. Capture, because xterm claims most of the keyboard.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[10vh]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      data-testid="shortcuts-cheatsheet"
    >
      <div className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">{t('cheatsheet.title')}</h2>
          {/* The reader is also the way to the editor: someone who came looking for a
              chord is the person most likely to want to change it. */}
          <p className="mt-0.5 text-xs text-muted-foreground">{t('cheatsheet.where')}</p>
        </div>
        <div className="max-h-[60vh] overflow-auto px-4 py-1">
          {SHORTCUT_COMMANDS.map((command) => {
            const binding = bindings[command.id];
            return (
              <div
                key={command.id}
                className="flex items-center justify-between gap-3 border-b border-border py-2.5 last:border-none"
                data-testid="cheatsheet-row"
                data-command={command.id}
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {t(`shortcuts.cmd.${command.id}.label`)}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {t(`shortcuts.cmd.${command.id}.description`)}
                  </div>
                </div>
                {/* A command with no chord is listed and says so, rather than being left
                    out: that it exists and can be given one is the useful fact. */}
                {binding ? (
                  <kbd className="flex-none rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                    {displayBinding(binding, IS_MAC)}
                  </kbd>
                ) : (
                  <span className="flex-none text-xs text-muted-foreground">
                    {t('shortcuts.unassigned')}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
