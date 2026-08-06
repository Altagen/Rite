/**
 * Identity pastille (accounts context) — the avatar + name + role chip pinned to the right of
 * the header, with a dropdown that says who's signed in and where, and holds the personal
 * actions (Settings, Sign out). Replaces the standalone gear + sign-out in a server session so
 * the header reads as "you". Matches the profile chip in design/mock/web.html / desktop.html.
 */

import { useState } from 'react';

const ROLE_PILL: Record<string, string> = {
  admin: 'bg-primary/15 text-primary',
  manager: 'bg-amber-500/15 text-amber-600',
  user: 'bg-secondary text-muted-foreground',
};

export function ProfilePastille({
  username,
  role,
  instanceName,
  onSettings,
  onSignOut,
}: {
  username: string;
  role: string;
  instanceName?: string | null;
  onSettings: () => void;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const initials = username.slice(0, 2).toUpperCase();
  const pill = ROLE_PILL[role] ?? ROLE_PILL.user;
  const avatar = (size: string) => (
    <span className={`grid ${size} flex-none place-items-center rounded-full bg-primary/15 text-xs font-bold uppercase text-primary`}>
      {initials}
    </span>
  );

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="m-btn m-btn-ghost m-btn-sm flex items-center gap-2"
        title="Your account"
      >
        {avatar('h-6 w-6')}
        <span className="hidden flex-col items-start leading-tight md:flex">
          <span className="text-xs font-semibold">{username}</span>
          <span className={`rounded px-1 text-[9px] font-bold uppercase tracking-wide ${pill}`}>{role}</span>
        </span>
        <svg className="h-3 w-3 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-[calc(100%+6px)] z-50 w-[240px] overflow-hidden rounded-xl border border-border bg-card shadow-xl">
            <div className="flex items-center gap-2.5 border-b border-border px-3.5 py-3">
              {avatar('h-9 w-9')}
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{username}</div>
                <div className="truncate text-xs text-muted-foreground">
                  Signed in{instanceName ? ` · ${instanceName}` : ''}
                </div>
              </div>
            </div>
            <div className="p-1">
              <button
                onClick={() => {
                  setOpen(false);
                  onSettings();
                }}
                className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm hover:bg-secondary"
              >
                <svg className="h-4 w-4 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
                </svg>
                Settings
              </button>
              <button
                onClick={() => {
                  setOpen(false);
                  onSignOut();
                }}
                className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm hover:bg-secondary"
              >
                <svg className="h-4 w-4 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" />
                </svg>
                Sign out
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
