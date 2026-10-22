/**
 * Split menu — what a divider can open, beyond a plain terminal.
 *
 * The split buttons beside this one split plainly, with no menu in the way, because
 * that is what most people want from a divider. Everything configurable lives here:
 * the plain split again (so the menu is a superset of the button rather than a
 * different feature), the user's presets, their snippets, and their layouts.
 *
 * The layouts come from the layouts file (docs/LAYOUTS.md), not from this menu's own
 * store: they have their own button beside the tabs now, and they are listed here as
 * well because someone who learned the chevron should not have to unlearn it.
 *
 * Opening a layout splits once per pane, in order and one after another, because
 * each split has to see the tree the previous one left behind — and the direction
 * alternates as it goes. Five panes all split the same way is six columns, which is
 * nobody's "five terminals arranged like this"; alternating makes a grid out of the
 * same number of splits.
 */

import { useEffect, useRef } from 'react';
import { useTranslation } from '../i18n/i18n';
import { useSnippets } from '../store/snippets';
import { useSplits, PLAIN_PRESET } from '../store/splits';
import { useLayouts } from '../store/layouts';
import type { SplitTarget } from '../types/pane';

interface Props {
  /** Split and run something in the new pane. */
  onSplitWith: (direction: 'horizontal' | 'vertical', target: SplitTarget) => Promise<void>;
  /**
   * Where a single new pane goes.
   *
   * One chevron serves both split buttons, so it has to pick one: it is the
   * horizontal button's direction, the same one the pane's first split button uses.
   * A layout ignores it after its first pane and alternates — see above.
   */
  direction: 'horizontal' | 'vertical';
  onConfigure: () => void;
  onClose: () => void;
}

export function SplitMenu({ onSplitWith, direction, onConfigure, onClose }: Props) {
  const { t } = useTranslation();
  const { presets } = useSplits();
  // No workspace to read, no preset library to configure: the plain split and the
  // snippets are all this menu has to offer then (ADR 0023, 0027).
  const hasWorkspaceFile = useLayouts((s) => s.available);
  const { snippets } = useSnippets();
  const ref = useRef<HTMLDivElement>(null);

  // Click anywhere else, or press Escape, and the menu is gone — a popover that
  // needs its own button pressed again to close is a popover people leave open.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const run = (target: SplitTarget) => {
    onClose();
    void onSplitWith(direction, target);
  };

  const row = (key: string, label: string, sub: string | null, onClick: () => void) => (
    <button
      key={key}
      onClick={onClick}
      className="w-full rounded px-3 py-2 text-left hover:bg-muted transition-colors"
    >
      <div className="text-sm font-medium text-foreground">{label}</div>
      {sub && <div className="truncate font-mono text-[11px] text-muted-foreground">{sub}</div>}
    </button>
  );

  const heading = (text: string) => (
    <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
      {text}
    </div>
  );

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full z-50 mt-1 max-h-[70vh] w-64 overflow-auto rounded-lg border border-border bg-card p-1 shadow-xl"
      role="menu"
      aria-label={t('split.menu')}
    >
      {row('plain', t('split.plain'), null, () => run(PLAIN_PRESET))}
      {presets.map((p) => row(p.id, p.name, p.command || null, () => run(p)))}

      {snippets.length > 0 && heading(t('split.snippets'))}
      {snippets.map((s) =>
        row(s.id, s.name, s.command.split('\n')[0], () =>
          run({ name: s.name, command: s.command }),
        ),
      )}

      {hasWorkspaceFile && (
        <>
          <div className="my-1 border-t border-border" />
          {row('configure', t('split.configure'), null, () => {
            onClose();
            onConfigure();
          })}
        </>
      )}
    </div>
  );
}
