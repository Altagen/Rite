/**
 * The standard right-hand controls for an accounts overlay page (Teams / Collections /
 * Notifications): the nav to the other surfaces, the notifications bell, Esc-to-close, and the
 * identity pastille (Settings + Sign out). One source of truth so every overlay's chrome matches.
 * Render it after the header's `.m-spacer`.
 *
 * The nav is here because these are pages you travel between: the bar used to hold a ✕ and an
 * avatar, so Collections → Teams cost a Close and then the button you had just left. Same list and
 * same renderer as the workspace's bar (`accountsNav.tsx`, `OverflowNav`), so the two bars cannot
 * disagree about what exists or what it is called. Pass `appbarRef` — the header element — and
 * give that header `m-appbar-fit`, which is what makes the overflow measurement meaningful.
 *
 * There is no Close button any more: the nav's first entry IS the way back, and it is named. A ✕
 * beside it would be a second answer to a question already answered — the duplicate the nav was
 * added to remove. Esc still closes, because a mode you open over the app should close that way.
 * The admin console is the exception on both counts: it carries no nav (its own rail already says
 * Teams and Collections), so it keeps its own ✕.
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
  const nav = useAccountsNav({ includeWorkspace: true });
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
