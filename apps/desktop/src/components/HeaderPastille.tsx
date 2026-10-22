/**
 * The header's right-hand pastille: a round glyph, a label, a chevron, and a menu.
 *
 * Written once because there are two of them now. The accounts context has had one since
 * the server work — avatar, username, role chip, with Settings and Sign out inside — and the
 * local-vault context carried a bare gear and a bare padlock instead, two icon buttons with
 * no shared grammar. Same bar, same corner, two different ideas about what lives there.
 *
 * This is the shell only: the trigger's contents and the menu's items are the caller's, so
 * "who is signed in" and "what state the vault is in" can both use it without either
 * pretending to be the other. A local vault has no identity to show, and an identity-shaped
 * control that says "Local" would only repeat what the context pill already says on the
 * other side of the bar.
 */

import { useState, type ReactNode } from 'react';

export interface PastilleItem {
  key: string;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  /** Red, for an action that destroys or signs out of something. */
  danger?: boolean;
}

export function HeaderPastille({
  title,
  glyph,
  primary,
  chip,
  chipClass,
  headerGlyph,
  headerPrimary,
  headerSecondary,
  items,
  testId,
}: {
  title: string;
  /** The round thing on the left: initials, or an icon. */
  glyph: ReactNode;
  /** The label beside it. Hidden below `md`, where the glyph stands alone. */
  primary: string;
  /** The small caps chip under the label, when there is one. */
  chip?: string;
  chipClass?: string;
  /** The same glyph at dropdown size — usually the caller's, one size up. */
  headerGlyph: ReactNode;
  headerPrimary: string;
  headerSecondary: string;
  items: PastilleItem[];
  testId?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="m-btn m-btn-ghost m-btn-sm flex items-center gap-2"
        title={title}
        data-testid={testId}
      >
        {glyph}
        <span className="hidden flex-col items-start leading-tight md:flex">
          <span className="text-xs font-semibold">{primary}</span>
          {chip && (
            <span
              className={`rounded px-1 text-[9px] font-bold uppercase tracking-wide ${chipClass ?? ''}`}
            >
              {chip}
            </span>
          )}
        </span>
        <svg
          className="h-3 w-3 text-muted-foreground"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-[calc(100%+6px)] z-50 w-[240px] overflow-hidden rounded-xl border border-border bg-card shadow-xl">
            <div className="flex items-center gap-2.5 border-b border-border px-3.5 py-3">
              {headerGlyph}
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{headerPrimary}</div>
                <div className="truncate text-xs text-muted-foreground">{headerSecondary}</div>
              </div>
            </div>
            <div className="p-1">
              {items.map((item) => (
                <button
                  key={item.key}
                  data-testid={`pastille-${item.key}`}
                  onClick={() => {
                    setOpen(false);
                    item.onClick();
                  }}
                  className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm hover:bg-secondary ${
                    item.danger ? 'text-red-500' : ''
                  }`}
                >
                  <span className={item.danger ? '' : 'text-muted-foreground'}>{item.icon}</span>
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
