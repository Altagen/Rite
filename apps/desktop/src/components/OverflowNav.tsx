/**
 * Progressive header overflow (matches design/mock/web.html fitBar). Renders a set of nav
 * actions inline and, when the appbar runs out of room, collapses them one at a time — from
 * the end — into a "⋯" menu, so the row never wraps and the identity pastille stays pinned
 * right. Measurement is imperative (scrollWidth vs clientWidth on the appbar, which must be
 * flex-nowrap); collapsing/expanding toggles each item's display in a layout effect before
 * paint, and only the menu contents are React state.
 */

import { useCallback, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

export interface NavAction {
  id: string;
  label: string;
  title?: string;
  icon: ReactNode;
  onClick: () => void;
}

export function OverflowNav({ actions, appbarRef }: { actions: NavAction[]; appbarRef: RefObject<HTMLElement | null> }) {
  const itemRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const ovBtnRef = useRef<HTMLButtonElement>(null);
  const [menuIds, setMenuIds] = useState<string[]>([]);
  const [open, setOpen] = useState(false);

  const fit = useCallback(() => {
    const bar = appbarRef.current;
    if (!bar) return;
    // Reset to all-inline, overflow button hidden, then shrink from the end while overflowing.
    for (const el of itemRefs.current.values()) el.style.display = '';
    if (ovBtnRef.current) ovBtnRef.current.style.display = 'none';
    const collapsed: string[] = [];
    for (let i = actions.length - 1; i >= 0; i--) {
      if (bar.scrollWidth <= bar.clientWidth) break;
      const el = itemRefs.current.get(actions[i].id);
      if (el) el.style.display = 'none';
      // Reveal the overflow button as soon as anything collapses, so its width is measured too.
      if (ovBtnRef.current) ovBtnRef.current.style.display = '';
      collapsed.unshift(actions[i].id);
    }
    setMenuIds((prev) => (prev.length === collapsed.length && prev.every((id, i) => id === collapsed[i]) ? prev : collapsed));
    if (collapsed.length === 0 && ovBtnRef.current) ovBtnRef.current.style.display = 'none';
  }, [actions, appbarRef]);

  useLayoutEffect(() => {
    fit();
    const bar = appbarRef.current;
    if (!bar) return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(bar);
    return () => ro.disconnect();
  }, [fit, appbarRef]);

  const menuActions = menuIds
    .map((id) => actions.find((a) => a.id === id))
    .filter((a): a is NavAction => !!a);

  return (
    <>
      {actions.map((a) => (
        <button
          key={a.id}
          ref={(el) => {
            if (el) itemRefs.current.set(a.id, el);
            else itemRefs.current.delete(a.id);
          }}
          onClick={a.onClick}
          className="m-btn m-btn-ghost m-btn-sm"
          title={a.title ?? a.label}
        >
          {a.icon}
          <span className="hidden md:inline">{a.label}</span>
        </button>
      ))}

      <div className="relative" style={{ display: menuIds.length ? undefined : 'none' }}>
        <button
          ref={ovBtnRef}
          onClick={() => setOpen((v) => !v)}
          className="m-btn m-btn-ghost m-btn-sm"
          title="More"
          style={{ display: 'none' }}
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <circle cx="5" cy="12" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="19" cy="12" r="1.6" />
          </svg>
        </button>
        {open && menuActions.length > 0 && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <div className="absolute right-0 top-[calc(100%+6px)] z-50 w-[210px] overflow-hidden rounded-xl border border-border bg-card p-1 shadow-xl">
              {menuActions.map((a) => (
                <button
                  key={a.id}
                  onClick={() => {
                    setOpen(false);
                    a.onClick();
                  }}
                  className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm hover:bg-secondary"
                >
                  <span className="grid place-items-center text-muted-foreground">{a.icon}</span>
                  {a.label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}
