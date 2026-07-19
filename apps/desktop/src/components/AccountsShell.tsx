/**
 * Accounts shell (ADR 0014 phase 2): the auth gate + connection source around the
 * shared `Workspace` for a shared-server session.
 *
 * A member lands in the full workspace (connections + terminals), backed by the
 * browser-crypto accounts source. The org-admin keeps the management surface
 * (`ServerHome`: users, teams, shared connections) until phase 3 folds both into
 * one hub. A token-only resume (reload without the password) can't decrypt the
 * vault, so it asks the user to sign in again rather than showing an empty shell.
 */

import { useServerSession } from '../store/serverSessionStore';
import { useAccountsConnectionsSource } from '../store/accountsConnectionsSource';
import { Workspace } from './Workspace';
import { ServerHome } from './ServerHome';

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
  if (!user) return null;

  // Org-admins keep the management surface for now (phase 3 unifies the two).
  if (user.role === 'admin') return <ServerHome />;

  // A member without the unwrapped vault key (token-only resume) must re-auth.
  if (!userKey) return <ReauthNotice onSignOut={() => logout()} />;

  return (
    <Workspace
      auth={{
        // Accounts sessions have no separate lock: the vault key lives only in RAM,
        // so "lock" clears it by signing out (back to the login screen).
        isLocked: false,
        lock: () => logout(),
        renderUnlockModal: () => null,
      }}
      conns={conns}
    />
  );
}
