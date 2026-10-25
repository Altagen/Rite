/**
 * The command palette: everything runnable, found by typing.
 *
 * WHY, and not a menu. The Settings rail already proved the point — scrolling stopped
 * working at fourteen sections. Commands have the same shape: a handful earn one of the
 * few good chords, the rest earn being findable. What a menu cannot do, and this does, is
 * list what can run RIGHT NOW: the registry holds a handler only while a mounted component
 * is implementing that command with `enabled` true (see `shortcuts/registry.ts`), so a
 * pane command with no pane focused is absent rather than greyed out. A disabled row says
 * "not now" without saying why or what instead.
 *
 * The chord shows beside each command, read from the same store the keyboard dispatches
 * from — so a remap moves it here too, and a changed default cannot leave a stale chord
 * behind in a second list. That mistake has been made in this app before:
 * `Split vertical (Ctrl+Shift+V)` outlived the default moving off that chord.
 *
 * Matching and ranking are a pure function (`shortcuts/palette.ts`) held by
 * `e2e/palette-filter-check.mjs`, because ranking IS the behaviour of a palette.
 *
 * Mirrors `design/mock/desktop.html`, which got the palette first (ADR 0019).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '../i18n/i18n';
import { SHORTCUT_COMMANDS } from '../shortcuts/commands';
import { filterPalette, type PaletteEntry } from '../shortcuts/palette';
import { useCommandRegistry, runCommand } from '../shortcuts/registry';
import { useShortcuts, IS_MAC } from '../shortcuts/store';
import { displayBinding } from '../shortcuts/binding';

/**
 * Mounted only while open (see `Workspace`), which is why there is no state to reset here:
 * a palette that remembered the last query would feel haunted, and an effect that cleared
 * it would be setting state from an effect — cascading renders for something a remount
 * does for free.
 */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const handlers = useCommandRegistry((s) => s.handlers);
  const bindings = useShortcuts((s) => s.bindings);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  /**
   * The runnable commands, in the table's order.
   *
   * Built from the table and filtered by the registry rather than listing the registry
   * directly: the table's order is a design call, and `Object.keys` order is not.
   */
  const entries: PaletteEntry[] = useMemo(
    () =>
      SHORTCUT_COMMANDS.filter((c) => c.id in handlers).map((c) => ({
        id: c.id,
        label: t(`shortcuts.cmd.${c.id}.label`),
        description: t(`shortcuts.cmd.${c.id}.description`),
        chord: bindings[c.id] ? displayBinding(bindings[c.id], IS_MAC) : undefined,
      })),
    [handlers, bindings, t],
  );
  const hits = useMemo(() => filterPalette(entries, query), [entries, query]);

  // The input is the whole interface, so it takes the focus rather than the container.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const run = (id: string) => {
    onClose();
    // Closed first: a command that opens a modal of its own would otherwise open it
    // behind this one.
    runCommand(id);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setPicked((p) => Math.min(p + 1, hits.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setPicked((p) => Math.max(p - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (hits[picked]) run(hits[picked].id);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  const at = Math.max(0, Math.min(picked, hits.length - 1));

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[12vh]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      data-testid="command-palette"
    >
      <div className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            // Any change puts the selection back on the best match: keeping it where it
            // was would run a command the list no longer shows first.
            setPicked(0);
          }}
          onKeyDown={onKeyDown}
          placeholder={t('palette.placeholder')}
          className="w-full border-b border-border bg-transparent px-4 py-3.5 text-base text-foreground placeholder:text-muted-foreground focus:outline-none"
          data-testid="palette-input"
        />
        <div className="max-h-80 overflow-auto p-1.5">
          {hits.length === 0 ? (
            <p className="px-3 py-2.5 text-sm text-muted-foreground" data-testid="palette-empty">
              {t('palette.empty')}
            </p>
          ) : (
            hits.map((entry, i) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => run(entry.id)}
                onMouseEnter={() => setPicked(i)}
                className={`flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left ${
                  i === at ? 'bg-muted ring-1 ring-inset ring-border' : 'hover:bg-muted'
                }`}
                data-testid="palette-row"
                data-command={entry.id}
                data-picked={i === at ? 'true' : undefined}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{entry.label}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {entry.description}
                  </span>
                </span>
                {/* Absent rather than empty when the command ships without a chord: an
                    empty box beside a row reads as a chord nobody can see. */}
                {entry.chord && (
                  <kbd className="flex-none rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                    {entry.chord}
                  </kbd>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
