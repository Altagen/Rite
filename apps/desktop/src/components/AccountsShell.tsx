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

import { useServerSession } from '../store/serverSessionStore';
import { useAccountsConnectionsSource } from '../store/accountsConnectionsSource';
import { useRoutePath, navigate } from '../store/route';
import { Workspace } from './Workspace';
import { AdminDashboard } from './AdminDashboard';
import { AdminOnlyNotice } from './AdminOnlyNotice';
import { CollectionsDashboard } from './CollectionsDashboard';
import { TeamsDashboard } from './TeamsDashboard';
import { IconCollection, IconShield, IconUsers } from './icons';

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
  const path = useRoutePath();
  if (!user) return null;

  // A user without the unwrapped vault key (token-only resume) must re-auth.
  if (!userKey) return <ReauthNotice onSignOut={() => logout()} />;

  const isAdmin = user.role === 'admin';
  // Runtime serve-surface gating (rite-admin-console-split): a deployment can turn
  // the admin console and/or the client workspace off. Both default on when absent.
  const serveAdmin = mode?.serveAdmin !== false;
  const serveWebui = mode?.serveWebui !== false;
  const canAdmin = isAdmin && serveAdmin;

  // Admin-only server (client workspace off): no Workspace at all — an admin gets the
  // console as the whole surface; anyone else is told they have no access here.
  if (!serveWebui) {
    return canAdmin ? (
      <AdminDashboard hideBack />
    ) : (
      <AdminOnlyNotice onSignOut={() => logout()} />
    );
  }

  // `/admin` and `/collections` are real routes rendered as overlays over the
  // (kept-mounted) workspace, so live terminals survive a trip to admin. A non-admin
  // (or an admin on a server with the console gated off) is bounced back to the app.
  if (path === '/admin' && !canAdmin) navigate('/');

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
            <button onClick={() => navigate('/teams')} className="m-btn m-btn-ghost m-btn-sm" title="Teams">
              <IconUsers className="h-4 w-4" />
              <span className="hidden md:inline">Teams</span>
            </button>
            <button onClick={() => navigate('/collections')} className="m-btn m-btn-ghost m-btn-sm" title="Collections">
              <IconCollection className="h-4 w-4" />
              <span className="hidden md:inline">Collections</span>
            </button>
            {canAdmin ? (
              <button onClick={() => navigate('/admin')} className="m-btn m-btn-ghost m-btn-sm" title="Administration">
                <IconShield className="h-4 w-4" />
                <span className="hidden md:inline">Admin</span>
              </button>
            ) : null}
          </>
        }
      />
      {path === '/teams' && <TeamsDashboard />}
      {path === '/collections' && <CollectionsDashboard />}
      {path === '/admin' && canAdmin && <AdminDashboard />}
    </>
  );
}
