/**
 * Admin surface (ADR 0014 phase 3): the org-admin management panels — users,
 * teams, and team shared connections — as an overlay *within* the workspace
 * rather than a separate top-level screen. Opened from the workspace header; the
 * session (sign-out) lives there too, so this only needs a way back.
 */

import { useState } from 'react';
import { AdminUsersPanel } from './AdminUsersPanel';
import { TeamsPanel } from './TeamsPanel';
import { TeamConnectionsPanel } from './TeamConnectionsPanel';
import { InstanceSettingsPanel } from './InstanceSettingsPanel';

export function AdminSurface({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'users' | 'teams' | 'connections' | 'instance'>('users');

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background text-foreground">
      <header className="flex items-center justify-between border-b border-border bg-card px-6 py-4">
        <h1 className="text-lg font-semibold">Administration</h1>
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

      <nav className="flex gap-1 border-b border-border bg-card px-6">
        {(['users', 'teams', 'connections', 'instance'] as const).map((t) => (
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

      <main className="flex-1 overflow-y-auto p-8">
        {tab === 'users' ? (
          <AdminUsersPanel />
        ) : tab === 'teams' ? (
          <TeamsPanel />
        ) : tab === 'connections' ? (
          <TeamConnectionsPanel />
        ) : (
          <InstanceSettingsPanel />
        )}
      </main>
    </div>
  );
}
