/**
 * Split menu — what a divider can open, beyond a plain terminal.
 *
 * The split buttons beside this one split plainly, with no menu in the way, because
 * that is what most people want from a divider. Everything configurable lives here:
 * the plain split again (so the menu is a superset of the button rather than a
 * different feature), the user's presets, their snippets, and their layouts.
 *
 * Opening a layout splits once per pane, in order and one after another, because
 * each split has to see the tree the previous one left behind.
 */

import { useEffect, useRef } from 'react';
import { useTranslation } from '../i18n/i18n';
import { useSnippets } from '../store/snippets';
import { useSplits, PLAIN_PRESET } from '../store/splits';

interface Props {
  /** Split and run something in the new pane. */
  onSplitWith: (direction: 'horizontal' | 'vertical', preset: { name: string; command: string }) => Promise<void>;
  /** Where the new panes go — the same direction the plain button would have used. */
  direction: 'horizontal' | 'vertical';
  onConfigure: () => void;
  onClose: () => void;
}

export function SplitMenu({ onSplitWith, direction, onConfigure, onClose }: Props) {
  const { t } = useTranslation();
  const { presets, layouts } = useSplits();
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

  const run = (preset: { name: string; command: string }) => {
    onClose();
    void onSplitWith(direction, preset);
  };

  const openLayout = (panes: { name: string; command: string }[]) => {
    onClose();
    void (async () => {
      for (const pane of panes) await onSplitWith(direction, pane);
    })();
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
        row(s.id, s.name, s.command.split('\n')[0], () => run({ name: s.name, command: s.command })),
      )}

      {layouts.length > 0 && heading(t('split.layouts'))}
      {layouts.map((l) =>
        row(l.id, l.name, t('split.panesCount', { count: l.panes.length }), () => openLayout(l.panes)),
      )}

      <div className="my-1 border-t border-border" />
      {row('configure', t('split.configure'), null, () => {
        onClose();
        onConfigure();
      })}
    </div>
  );
}
