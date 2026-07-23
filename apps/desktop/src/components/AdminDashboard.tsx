/**
 * Admin console (ADR 0014 phase 3, ADR 0010) at the `/admin` route — a dedicated
 * dashboard for server operators, separate from the connection manager so it can
 * later be served on its own (rite-admin-console-split). Left nav: Overview / Users
 * / Teams / Collections / Instance. Users/Teams/Instance reuse the existing panels;
 * Overview and Collections are new. Admin-role gating is the caller's.
 */

import { useEffect, useState } from 'react';
import { useServerSession } from '../store/serverSessionStore';
import { navigate } from '../store/route';
import { Backend, type ServerUser } from '../utils/backend';
import { AdminUsersPanel } from './AdminUsersPanel';
import { TeamsPanel } from './TeamsPanel';
import { InstanceSettingsPanel } from './InstanceSettingsPanel';
import { IconUsers, IconShield, IconGear, IconLock, IconCollection } from './icons';
import riteLogo from '../assets/rite.png';

type Sec = 'overview' | 'users' | 'teams' | 'collections' | 'instance';

const NAV: { id: Sec; label: string; icon: React.ReactNode }[] = [
  { id: 'overview', label: 'Overview', icon: <IconGrid /> },
  { id: 'users', label: 'Users', icon: <IconUsers className="h-4 w-4" /> },
  { id: 'teams', label: 'Teams', icon: <IconUsers className="h-4 w-4" /> },
  { id: 'collections', label: 'Collections', icon: <IconCollection className="h-4 w-4" /> },
  { id: 'instance', label: 'Instance', icon: <IconGear className="h-4 w-4" /> },
];

function IconGrid() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </svg>
  );
}

export function AdminDashboard() {
  const { mode, logout } = useServerSession();
  const [sec, setSec] = useState<Sec>('overview');

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background text-foreground">
      {/* Top bar — a distinct admin surface */}
      <header className="m-appbar">
        <div className="m-brand flex items-center gap-2.5">
          <img src={riteLogo} alt="Rite" className="h-[26px] rounded-[7px]" />
          <span className="rounded-md border border-primary/40 px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-primary">
            Admin
          </span>
        </div>
        {mode?.instanceName && (
          <span className="m-chip" title="Server instance">
            <span className="m-dot" />
            {mode.instanceName}
          </span>
        )}
        <span className="m-spacer" />
        <button onClick={() => navigate('/')} className="m-btn m-btn-sm" title="Back to the connection manager">
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

      <div className="flex min-h-0 flex-1">
        {/* Left nav */}
        <nav className="flex w-[220px] flex-shrink-0 flex-col gap-0.5 border-r border-border bg-input p-2.5">
          {NAV.map((n) => (
            <button
              key={n.id}
              onClick={() => setSec(n.id)}
              className={`flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left text-sm font-medium transition ${
                sec === n.id
                  ? 'border-primary/30 bg-primary/[0.13] text-primary'
                  : 'border-transparent text-muted-foreground hover:bg-secondary'
              }`}
            >
              <span className="grid place-items-center opacity-85">{n.icon}</span>
              {n.label}
            </button>
          ))}
        </nav>

        {/* Content */}
        <main className="min-w-0 flex-1 overflow-y-auto px-8 py-7">
          <div className="mx-auto max-w-[1400px]">
            {sec === 'overview' && <Overview onGo={setSec} />}
            {sec === 'users' && <AdminUsersPanel />}
            {sec === 'teams' && <TeamsPanel />}
            {sec === 'collections' && <CollectionsGovernance />}
            {sec === 'instance' && <InstanceSettingsPanel />}
          </div>
        </main>
      </div>
    </div>
  );
}

function StatCard({ k, v, d }: { k: string; v: React.ReactNode; d?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-[16px_18px]">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{k}</div>
      <div className="mt-1.5 text-[30px] font-bold leading-none">{v}</div>
      {d && <div className="mt-1.5 text-xs text-muted-foreground">{d}</div>}
    </div>
  );
}

function Overview({ onGo }: { onGo: (s: Sec) => void }) {
  const [users, setUsers] = useState<ServerUser[] | null>(null);
  useEffect(() => {
    Backend.Admin.listUsers().then(setUsers).catch(() => setUsers([]));
  }, []);
  const admins = users?.filter((u) => u.role === 'admin').length ?? 0;
  const active = users?.filter((u) => u.status === 'active').length ?? 0;

  return (
    <>
      <div className="mb-5 flex items-center gap-3.5">
        <h1 className="text-[22px] font-bold">Overview</h1>
        <span className="text-[13px] text-muted-foreground">This Rite instance at a glance</span>
      </div>
      <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]">
        <button onClick={() => onGo('users')} className="text-left">
          <StatCard k="Users" v={users ? users.length : '…'} d={users ? `${active} active` : undefined} />
        </button>
        <StatCard k="Admins" v={users ? admins : '…'} d="with full server access" />
        <button onClick={() => onGo('teams')} className="text-left">
          <StatCard k="Teams" v="—" d="open Teams to manage" />
        </button>
        <StatCard k="Live sessions" v="—" d="terminals open now" />
      </div>
    </>
  );
}

function CollectionsGovernance() {
  return (
    <>
      <div className="mb-5">
        <h1 className="text-[22px] font-bold">Collections</h1>
        <span className="text-[13px] text-muted-foreground">Server-wide governance</span>
      </div>
      <div className="mb-5 flex max-w-[820px] items-start gap-2.5 rounded-xl border border-primary/25 bg-primary/[0.08] p-3.5 text-[13px] text-foreground/80">
        <IconShield className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" />
        <div>
          <b>Zero-knowledge.</b> Machine hosts &amp; credentials are encrypted end-to-end — even admins can&rsquo;t
          read them. Governance (listing collections, membership and policy) needs a dedicated server endpoint —
          designed in the mock (<code>design/mock/admin.html</code>), not yet wired here.
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        Coming next: the collections list (name / owner / members / machines), drill-in membership management, and
        policy toggles. Tracked in the <code>rite-admin-console-split</code> plan.
      </p>
    </>
  );
}
