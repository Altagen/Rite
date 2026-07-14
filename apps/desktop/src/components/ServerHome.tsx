/**
 * Authenticated server landing (ADR 0010 phase 1 placeholder).
 *
 * Confirms the session works. Per-user data (connections, terminals) and the
 * admin surface land in later phases; for now this proves login end to end.
 */

import { useServerSession } from '../store/serverSessionStore';
import { AdminUsersPanel } from './AdminUsersPanel';

export function ServerHome() {
  const { user, logout } = useServerSession();
  if (!user) return null;

  const isAdmin = user.role === 'admin';

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex items-center justify-between border-b border-border bg-card px-6 py-4">
        <h1 className="text-lg font-semibold">Rite server{isAdmin && ' — admin'}</h1>
        <div className="flex items-center gap-4">
          <span className="text-sm text-muted-foreground">
            {user.username}
            <span className="ml-2 rounded bg-muted px-2 py-0.5 text-xs uppercase">{user.role}</span>
          </span>
          <button
            onClick={() => logout()}
            className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto p-8">
        {isAdmin ? (
          <AdminUsersPanel />
        ) : (
          <div className="flex h-full items-center justify-center">
            <div className="max-w-md text-center">
              <p className="text-2xl font-medium">Connected as {user.username}</p>
              <p className="mt-3 text-sm text-muted-foreground">
                You are authenticated to this Rite server. Your workspace and server-hosted sessions
                arrive in the next phases.
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
