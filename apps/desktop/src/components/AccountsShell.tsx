/**
 * Accounts shell (ADR 0014 phases 2–3): the auth gate + connection source around
 * the shared `Workspace` for a shared-server session.
 *
 * Everyone — member and org-admin — lands in the one workspace (connections +
 * terminals), backed by the browser-crypto accounts source. The org-admin gets an
 * extra header entry that opens the management panels (users, teams, shared
 * connections) as a surface *within* the workspace, rather than a separate screen.
 * A token-only resume (reload without the password) can't decrypt the vault, so it
 * asks the user to sign in again rather than showing an empty shell.
 */

import { useState } from 'react';
import { useServerSession } from '../store/serverSessionStore';
import { useAccountsConnectionsSource } from '../store/accountsConnectionsSource';
import { Workspace } from './Workspace';
import { AdminSurface } from './AdminSurface';
import { CollectionsPanel } from './CollectionsPanel';

/** The collections management surface — an overlay open to every org member. */
function CollectionsSurface({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background text-foreground">
      <header className="flex items-center justify-between border-b border-border bg-card px-6 py-4">
        <h1 className="text-lg font-semibold">Collections</h1>
        <button
          onClick={onClose}
          className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
          </svg>
          Back to workspace
        </button>
      </header>
      <main className="flex-1 overflow-y-auto p-8">
        <CollectionsPanel />
      </main>
    </div>
  );
}

/** Reload without the password left no keys in RAM — re-auth to decrypt. */
function ReauthNotice({ onSignOut }: { onSignOut: () => void }) {
  return (
    <div className="flex h-screen items-center justify-center bg-background text-foreground">
      <div className="mx-4 w-full max-w-md rounded-lg border border-border bg-card p-6 text-center shadow-xl">
        <h1 className="mb-2 text-lg font-semibold">Session locked</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          Your vault key stays in memory only. Sign in again to unlock your connections.
        </p>
        <button
          onClick={onSignOut}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Sign in again
        </button>
      </div>
    </div>
  );
}

export function AccountsShell() {
  const { user, userKey, logout, mode } = useServerSession();
  const conns = useAccountsConnectionsSource();
  const [showAdmin, setShowAdmin] = useState(false);
  const [showCollections, setShowCollections] = useState(false);
  if (!user) return null;

  // A user without the unwrapped vault key (token-only resume) must re-auth.
  if (!userKey) return <ReauthNotice onSignOut={() => logout()} />;

  const isAdmin = user.role === 'admin';

  return (
    <>
      <Workspace
        auth={{
          // Accounts sessions have no separate lock: the vault key lives only in
          // RAM, so "sign out" clears it (back to the login screen).
          isLocked: false,
          lock: () => logout(),
          renderUnlockModal: () => null,
          lockLabel: 'Sign out',
        }}
        conns={conns}
        instanceName={mode?.instanceName}
        headerExtra={
          <>
            <button
              onClick={() => setShowCollections(true)}
              className="m-btn m-btn-ghost m-btn-sm"
              title="Collections"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3.75 6A2.25 2.25 0 016 3.75h2.25L9.75 6h8.25A2.25 2.25 0 0120.25 8.25v9A2.25 2.25 0 0118 19.5H6a2.25 2.25 0 01-2.25-2.25V6z" />
              </svg>
              <span>Collections</span>
            </button>
            {isAdmin ? (
              <button
                onClick={() => setShowAdmin(true)}
                className="m-btn m-btn-ghost m-btn-sm"
                title="Administration"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                <span>Admin</span>
              </button>
            ) : null}
          </>
        }
      />
      {showCollections && <CollectionsSurface onClose={() => setShowCollections(false)} />}
      {showAdmin && isAdmin && <AdminSurface onClose={() => setShowAdmin(false)} />}
    </>
  );
}
