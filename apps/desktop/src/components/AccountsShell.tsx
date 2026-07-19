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
  const { user, userKey, logout } = useServerSession();
  const conns = useAccountsConnectionsSource();
  const [showAdmin, setShowAdmin] = useState(false);
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
        headerExtra={
          isAdmin ? (
            <button
              onClick={() => setShowAdmin(true)}
              className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted transition-colors"
              title="Administration"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              <span>Admin</span>
            </button>
          ) : null
        }
      />
      {showAdmin && isAdmin && <AdminSurface onClose={() => setShowAdmin(false)} />}
    </>
  );
}
