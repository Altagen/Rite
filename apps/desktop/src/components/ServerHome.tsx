/**
 * Authenticated server landing (ADR 0010 phase 1 placeholder).
 *
 * Confirms the session works. Per-user data (connections, terminals) and the
 * admin surface land in later phases; for now this proves login end to end.
 */

import { useState } from 'react';
import { useServerSession } from '../store/serverSessionStore';
import { AdminUsersPanel } from './AdminUsersPanel';
import { TeamsPanel } from './TeamsPanel';
import { TeamConnectionsPanel } from './TeamConnectionsPanel';

export function ServerHome() {
  const { user, logout } = useServerSession();
  const [tab, setTab] = useState<'users' | 'teams' | 'connections'>('users');
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

      {isAdmin && (
        <nav className="flex gap-1 border-b border-border bg-card px-6">
          {(['users', 'teams', 'connections'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium capitalize ${
                tab === t
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {t}
            </button>
          ))}
        </nav>
      )}

      <main className="flex-1 overflow-y-auto p-8">
        {isAdmin ? (
          tab === 'users' ? (
            <AdminUsersPanel />
          ) : tab === 'teams' ? (
            <TeamsPanel />
          ) : (
            <TeamConnectionsPanel />
          )
        ) : (
          // Members land on their shared team connections.
          <TeamConnectionsPanel />
        )}
      </main>
    </div>
  );
}
