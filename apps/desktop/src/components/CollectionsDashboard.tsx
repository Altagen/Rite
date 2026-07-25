/**
 * The user's collection manager at the `/collections` route (ADR 0016) — the
 * collections I'm a member of, opened from the header. A dedicated page (top bar +
 * the master-detail CollectionsPanel: rail on the left, editor on the right),
 * matching design/mock/collections.html.
 */

import { useServerSession } from '../store/serverSessionStore';
import { navigate } from '../store/route';
import { CollectionsPanel } from './CollectionsPanel';
import { IconLock } from './icons';
import riteLogo from '../assets/rite.png';

export function CollectionsDashboard() {
  const { mode, logout } = useServerSession();
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background text-foreground">
      <header className="m-appbar">
        <div className="m-brand flex items-center gap-2.5">
          <img src={riteLogo} alt="Rite" className="h-[26px] rounded-[7px]" />
        </div>
        {mode?.instanceName && (
          <span className="m-chip" title="Server instance">
            <span className="m-dot" />
            {mode.instanceName}
          </span>
        )}
        <span className="m-spacer" />
        <button onClick={() => navigate('/')} className="m-btn m-btn-sm" title="Back to the app">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 6l-6 6 6 6" />
          </svg>
          <span className="hidden md:inline">Back to app</span>
        </button>
        <button onClick={() => logout()} className="m-btn m-btn-ghost m-btn-sm" title="Sign out">
          <IconLock className="h-4 w-4" />
          <span className="hidden md:inline">Sign out</span>
        </button>
      </header>
      <CollectionsPanel />
    </div>
  );
}
