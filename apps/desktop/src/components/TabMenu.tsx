/**
 * A tab's own menu, on right click.
 *
 * Rename is here as well as on the pencil and the double-click, because a menu that omits
 * what people already know how to do reads as a different menu for different tabs. The
 * two it ADDS are the ones with nowhere else to live.
 *
 * DUPLICATE CANNOT COPY A TAB, and the label has to say so. Each pane holds a live
 * session, and an SSH connection is not a value anyone can clone — so what a duplicate
 * gives is the same arrangement against the same targets with fresh sessions. Someone who
 * read a bare "Duplicate tab" would expect their scrollback and their running job back.
 *
 * Positioned at the pointer, which is what makes it a context menu rather than a dropdown
 * that happens to open elsewhere. Dismissal follows `SplitMenu`: a mousedown outside, or
 * Escape.
 *
 * Mirrors `design/mock/desktop.html`, which got it first (ADR 0019).
 */
import { useEffect, useRef } from 'react';
import { useTranslation } from '../i18n/i18n';

interface Props {
  /** Where the pointer was, in viewport coordinates. */
  at: { x: number; y: number };
  onRename: () => void;
  onDuplicate: () => void;
  /** Absent when this is the only tab: there would be no others to close. */
  onCloseOthers?: () => void;
  onClose: () => void;
}

export function TabMenu({ at, onRename, onDuplicate, onCloseOthers, onClose }: Props) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement | null>(null);

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

  const run = (action: () => void) => () => {
    // Closed first: a menu left open over the tab strip swallows the next click on a tab,
    // and "close others" removes the strip from under it.
    onClose();
    action();
  };

  const row = (key: string, label: string, sub: string | null, onClick: () => void) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      className="w-full rounded px-3 py-2 text-left transition-colors hover:bg-muted"
      data-testid={`tab-menu-${key}`}
    >
      <div className="text-sm font-medium text-foreground">{label}</div>
      {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
    </button>
  );

  return (
    <div
      ref={ref}
      // Clamped to the viewport so a tab near the right edge does not open a menu off
      // screen. The strip is at the top, so downward is always the right direction.
      style={{ left: Math.min(at.x, window.innerWidth - 240), top: at.y }}
      className="fixed z-[220] w-56 rounded-lg border border-border bg-card p-1 shadow-xl"
      data-testid="tab-menu"
    >
      {row('rename', t('tm.renameTab'), null, run(onRename))}
      {row('duplicate', t('tm.duplicateTab'), t('tm.duplicateTabWhy'), run(onDuplicate))}
      {onCloseOthers && row('close-others', t('tm.closeOthers'), null, run(onCloseOthers))}
    </div>
  );
}
