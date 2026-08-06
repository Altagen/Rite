/**
 * The standard right-hand controls for an accounts overlay page (Teams / Collections /
 * Notifications / Administration): a "Close" (×) that returns to the app, Esc-to-close, and the
 * identity pastille (Settings + Sign out). One source of truth so every overlay's chrome matches.
 * Render it after the header's `.m-spacer`.
 */

import { useEffect } from 'react';
import { navigate } from '../store/route';
import { useServerSession } from '../store/serverSessionStore';
import { useSettingsModal } from '../store/settingsModal';
import { ProfilePastille } from './ProfilePastille';

export function OverlayHeaderControls() {
  const { user, mode, logout } = useServerSession();
  const setSettingsOpen = useSettingsModal((s) => s.setOpen);

  // Esc closes the overlay (a "mode" you open and close over the app), matching the × button.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') navigate('/');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
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
