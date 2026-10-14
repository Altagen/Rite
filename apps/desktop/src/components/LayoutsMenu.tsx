/**
 * The Layouts button, in the tab strip.
 *
 * A layout arranges a whole tab — five terminals set up a particular way — so it
 * belongs beside the tabs and not inside one pane's split menu, which is where it
 * first shipped. That menu still offers them, because someone who learned the chevron
 * should not have to unlearn it; this is the obvious place, not the only one.
 *
 * The button hides itself when the file declares nothing: an empty dropdown beside
 * the tabs is a permanent invitation to find out it is empty. A file that does not
 * parse is the opposite — that is exactly when you want the button, so it stays and
 * says so.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from '../i18n/i18n';
import { useLayouts } from '../store/layouts';
import { LayoutsModal } from './LayoutsModal';
import type { LayoutPane } from '../store/layoutsFormat';

interface Props {
  /** Open a layout: one pane after another, in the active tab. */
  onApplyLayout: (panes: LayoutPane[]) => Promise<void>;
  connections: { name: string }[];
  libraryReadable: boolean;
}

export function LayoutsMenu({ onApplyLayout, connections, libraryReadable }: Props) {
  const { t } = useTranslation();
  const { layouts, error, loaded, load } = useLayouts();
  const [open, setOpen] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [at, setAt] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  // Positioned from the button rather than anchored to it: the tab strip scrolls
  // horizontally and clips its own overflow, so a menu inside it gets cut off.
  const place = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setAt({ top: r.bottom + 4, left: Math.max(8, r.right - 280) });
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // Nothing declared and nothing wrong → no button. See the note at the top.
  if (layouts.length === 0 && !error && !configuring) return null;

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => {
          place();
          setOpen((v) => !v);
        }}
        className={`flex flex-shrink-0 items-center gap-1 rounded px-2 py-1.5 text-sm transition-colors hover:bg-muted hover:text-foreground ${
          error ? 'text-amber-500' : 'text-muted-foreground'
        }`}
        title={error ? t('layouts.fileHasError') : t('split.layoutsTitle')}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="layouts-button"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 5h16v14H4zM12 5v14M4 12h8"
          />
        </svg>
        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open &&
        createPortal(
          <>
            <div className="fixed inset-0 z-[100]" onClick={() => setOpen(false)} />
            <div
              role="menu"
              aria-label={t('split.layoutsTitle')}
              className="fixed z-[110] max-h-[70vh] w-[280px] overflow-auto rounded-lg border border-border bg-card p-1 shadow-xl"
              style={{ top: `${at.top}px`, left: `${at.left}px` }}
            >
              {error && (
                <button
                  onClick={() => {
                    setOpen(false);
                    setConfiguring(true);
                  }}
                  className="w-full rounded px-3 py-2 text-left transition-colors hover:bg-muted"
                  data-testid="layouts-menu-error"
                >
                  <div className="truncate text-sm font-medium text-amber-500">
                    {t('layouts.fileHasError')}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {error.line > 0 ? `${t('layouts.atLine', { line: error.line })} ` : ''}
                    {error.message}
                  </div>
                </button>
              )}
              {layouts.map((l) => (
                <button
                  key={l.id}
                  onClick={() => {
                    setOpen(false);
                    void onApplyLayout(l.panes);
                  }}
                  className="w-full rounded px-3 py-2 text-left transition-colors hover:bg-muted"
                >
                  <div className="truncate text-sm font-medium text-foreground">{l.name}</div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {t('split.panesCount', { count: l.panes.length })} ·{' '}
                    {l.panes.map((p) => p.machine ?? p.name ?? p.command ?? '').join(' · ')}
                  </div>
                </button>
              ))}
              <div className="my-1 border-t border-border" />
              <button
                onClick={() => {
                  setOpen(false);
                  setConfiguring(true);
                }}
                className="w-full rounded px-3 py-2 text-left text-sm font-medium text-foreground transition-colors hover:bg-muted"
                data-testid="configure-layouts"
              >
                {t('layouts.openFile')}
              </button>
            </div>
          </>,
          document.body,
        )}

      {configuring && (
        <LayoutsModal
          connections={connections}
          libraryReadable={libraryReadable}
          onClose={() => setConfiguring(false)}
        />
      )}
    </>
  );
}
