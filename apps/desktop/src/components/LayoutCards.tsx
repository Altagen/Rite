/**
 * What the layouts file opens, as cards — grouped by tab, resolved against the
 * library this computer actually has.
 *
 * It lived inside the file editor, which meant the only way to see what you had was
 * to open the editor and scroll past a textarea. The interesting question is not "is
 * my TOML valid" but "will this open what I think it opens, on this computer, today",
 * and that deserves to be the first thing on the screen rather than a reward for
 * opening the file. So the cards are their own component and the editor is one of two
 * places that shows them.
 *
 * `onToggleStartup` is optional on purpose. In **Settings** the switch writes the key
 * straight into the file, which is safe because nothing else there holds an unsaved
 * copy of it. The **editor** passes nothing: it has a draft in a textarea, and a
 * switch that rewrote the file under an unsaved edit would discard it. There the
 * badge stays what it has always been — a statement, not a control.
 */

import { useTranslation } from '../i18n/i18n';
import { paneLabel, planLayout, type Layout } from '../store/layoutsFormat';

interface Props {
  layouts: Layout[];
  /** The machines this context can open, for resolving what the file names. Only
   *  their names matter here, so that is all this asks for. */
  connections: { name: string }[];
  /** False when the vault is locked: names cannot be resolved at all, which is not
   *  the same as a name being wrong, and the reader deserves the difference. */
  libraryReadable: boolean;
  /** Given a layout's position in the file, turn its `startup` on or off. Omitted
   *  where an unsaved draft of the file exists — see the note above. */
  onToggleStartup?: (index: number, startup: boolean) => void;
}

export function LayoutCards({ layouts, connections, libraryReadable, onToggleStartup }: Props) {
  const { t } = useTranslation();

  const known = new Set(connections.map((c) => c.name));
  const paneWhere = (machine: string | undefined) => {
    if (!machine) return { label: t('layouts.thisComputer'), ok: true };
    if (!libraryReadable) return { label: `${machine} — ${t('layouts.needsVault')}`, ok: false };
    if (!known.has(machine)) return { label: `${machine} — ${t('layouts.notInLibrary')}`, ok: false };
    return { label: machine, ok: true };
  };

  return (
    <ul className="space-y-2" data-testid="layout-cards">
      {layouts.map((layout, index) => (
        <li key={layout.id} className="rounded border border-border bg-muted/40 px-2.5 py-2">
          <div className="mb-1 flex items-center gap-2">
            <span className="truncate text-sm font-medium">{layout.name}</span>
            <span className="flex-none rounded border border-border px-1 text-[10px] font-semibold text-muted-foreground">
              {t('split.panesCount', { count: layout.panes.length })}
            </span>
            {onToggleStartup ? (
              // A checkbox and not a radio: the file lets several layouts open at
              // startup, each in its own tabs, and that is useful — one for what you
              // watch, one for what you work on. A radio would be a narrower file
              // format pretending to be a widget.
              <label className="ml-auto flex flex-none items-center gap-1.5 text-[10px] font-semibold text-muted-foreground">
                <input
                  type="checkbox"
                  className="h-3 w-3 accent-primary"
                  checked={layout.startup}
                  onChange={(e) => onToggleStartup(index, e.target.checked)}
                  data-testid={`startup-toggle-${index}`}
                />
                {t('layouts.atStartup')}
              </label>
            ) : (
              layout.startup && (
                <span className="flex-none rounded border border-primary px-1 text-[10px] font-semibold text-primary">
                  {t('layouts.atStartup')}
                </span>
              )
            )}
          </div>
          {/* Grouped the way it will open: a layout may name tabs, and a pane listed
              under the wrong one would be the opposite of what this list is for. */}
          {planLayout(layout).map((plan, p) => (
            <div key={p}>
              {plan.tab && (
                <div className="pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('layouts.inTab', { tab: plan.tab })}
                </div>
              )}
              {plan.panes.map((pane, i) => {
                const where = paneWhere(pane.machine);
                return (
                  <div key={i} className="flex gap-2 py-0.5 text-xs">
                    <span
                      className={`w-44 flex-none truncate ${where.ok ? 'text-muted-foreground' : 'text-amber-500'}`}
                    >
                      {where.label}
                    </span>
                    <code className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
                      {pane.command || t('layouts.plainShell')}
                    </code>
                    <span className="flex-none text-muted-foreground">{paneLabel(pane)}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </li>
      ))}
    </ul>
  );
}
