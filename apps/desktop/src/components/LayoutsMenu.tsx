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

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from '../i18n/i18n';
import { useLayouts } from '../store/layouts';
import { placeMenu } from '../utils/placeMenu';
import { LayoutsModal } from './LayoutsModal';
import type { Layout } from '../store/layoutsFormat';

/** Matches the `w-[280px]` below: the placement rule needs the width as a number. */
const MENU_WIDTH = 280;

interface Props {
  /** Open a layout: one pane after another, in the active tab. */
  onApplyLayout: (layout: Layout) => Promise<void>;
  connections: { name: string }[];
  libraryReadable: boolean;
}

export function LayoutsMenu({ onApplyLayout, connections, libraryReadable }: Props) {
  const { t } = useTranslation();
  const { layouts, error, loaded, load } = useLayouts();
  const [open, setOpen] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [at, setAt] = useState({ top: 0, left: 0, maxHeight: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  // Positioned from the button rather than anchored to it: the tab strip scrolls
  // horizontally and clips its own overflow, so a menu inside it gets cut off.
  //
  // Where exactly is `placeMenu`'s to decide, not this component's. This used to be
  // `top: r.bottom + 4` with no reference to the viewport height, which is fine for
  // a button in a header and wrong for the one in the empty state, where the button
  // is vertically centred: the list opened below mid-screen and ran off the bottom.
  const place = (desiredHeight?: number) => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    setAt(
      placeMenu(
        r,
        // Before the menu exists there is nothing to measure, so the first pass asks
        // for the most it could want and the effect below corrects it from the real
        // content — in a layout effect, so the correction lands before paint.
        { width: MENU_WIDTH, height: desiredHeight ?? Math.round(window.innerHeight * 0.7) },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  };

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => place(menuRef.current?.scrollHeight);
    measure();
    // A resize while the menu is open moves the button and changes the room.
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, layouts.length, error]);

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
              ref={menuRef}
              role="menu"
              aria-label={t('split.layoutsTitle')}
              data-testid="layouts-menu"
              className="fixed z-[110] w-[280px] overflow-auto rounded-lg border border-border bg-card p-1 shadow-xl"
              style={{ top: `${at.top}px`, left: `${at.left}px`, maxHeight: `${at.maxHeight}px` }}
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
                    void onApplyLayout(l);
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
