/**
 * The standard right-hand controls for an accounts overlay page (Teams / Collections /
 * Notifications): the nav to the other pages, the notifications bell, a "Close" (×) that returns
 * to the app, Esc-to-close, and the identity pastille (Settings + Sign out). One source of truth
 * so every overlay's chrome matches. Render it after the header's `.m-spacer`.
 *
 * The nav is here because these are pages you travel between: without it the bar held Close and
 * an avatar, so Collections → Teams cost a Close and then the button you had just left. Same list
 * and same renderer as the workspace's bar (`accountsNav.tsx`, `OverflowNav`), so the two bars
 * cannot disagree about what exists or what it is called. Pass `appbarRef` — the header element —
 * and give that header `m-appbar-fit`, which is what makes the overflow measurement meaningful.
 */

import { useEffect, type RefObject } from 'react';
import { navigate, useRoutePath } from '../store/route';
import { useServerSession } from '../store/serverSessionStore';
import { useSettingsModal } from '../store/settingsModal';
import { AccessRequestsBell } from './AccessRequestsInbox';
import { ProfilePastille } from './ProfilePastille';
import { OverflowNav } from './OverflowNav';
import { useAccountsNav } from './accountsNav';

export function OverlayHeaderControls({ appbarRef }: { appbarRef?: RefObject<HTMLElement | null> }) {
  const { user, mode, logout } = useServerSession();
  const setSettingsOpen = useSettingsModal((s) => s.setOpen);
  const settingsOpen = useSettingsModal((s) => s.open);
  const nav = useAccountsNav();
  const path = useRoutePath();

  // Esc closes the overlay (a "mode" you open and close over the app), matching the × button —
  // but not while the Settings modal is open over it (Esc there is the modal's to handle/ignore).
  useEffect(() => {
    if (settingsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') navigate('/');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [settingsOpen]);

  return (
    <>
      {/* The nav folds into "⋯" before the row wraps, exactly as in the workspace. Without a
          header ref there is nothing to measure, so the nav is left out rather than rendered
          into a bar it could overflow. */}
      {appbarRef && nav.length > 0 && <OverflowNav actions={nav} appbarRef={appbarRef} />}
      {/* No bell on the notifications page itself: that page IS the inbox, and a button that
          opens what you are already reading is a button with nothing to do. */}
      {path !== '/notifications' && <AccessRequestsBell />}
      <button onClick={() => navigate('/')} className="m-btn m-btn-sm" title="Close — back to the app (Esc)">
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6L6 18" />
        </svg>
        <span className="hidden md:inline">Close</span>
      </button>
      {user && (
        <ProfilePastille
          username={user.username}
          role={user.role}
          instanceName={mode?.instanceName}
          onSettings={() => setSettingsOpen(true)}
          onSignOut={() => logout()}
        />
      )}
    </>
  );
}
