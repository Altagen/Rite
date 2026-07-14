/**
 * Authenticated server landing (ADR 0010 phase 1 placeholder).
 *
 * Confirms the session works. Per-user data (connections, terminals) and the
 * admin surface land in later phases; for now this proves login end to end.
 */

import { useServerSession } from '../store/serverSessionStore';

export function ServerHome() {
  const { user, logout } = useServerSession();
  if (!user) return null;

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex items-center justify-between border-b border-border bg-card px-6 py-4">
        <h1 className="text-lg font-semibold">Rite server</h1>
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

      <main className="flex flex-1 items-center justify-center p-8">
        <div className="max-w-md text-center">
          <p className="text-2xl font-medium">Connected as {user.username}</p>
          <p className="mt-3 text-sm text-muted-foreground">
            You are authenticated to this Rite server
            {user.role === 'admin' ? ' as an administrator' : ''}. Your workspace and
            {user.role === 'admin' ? ' the admin tools' : ' server-hosted sessions'} arrive in the
            next phases.
          </p>
        </div>
      </main>
    </div>
  );
}
