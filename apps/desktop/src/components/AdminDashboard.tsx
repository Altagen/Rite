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
import { Backend, type ServerUser, type CollectionSummary, type CollectionMember } from '../utils/backend';
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

function ZkBanner() {
  return (
    <div className="mb-5 flex items-start gap-2.5 rounded-xl border border-primary/25 bg-primary/[0.08] p-3.5 text-[13px] text-foreground/80">
      <IconShield className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" />
      <div>
        <b>Zero-knowledge.</b> Collection names &amp; machine credentials are encrypted with a key only members hold —
        the server (and this list) can&rsquo;t read them, so collections show by id for now. Admins govern membership
        and lifecycle: you can remove a member or delete a collection, but <b>adding</b> a member needs the collection
        key and stays a member action (from <code>/collections</code>). Reading names / adding members lands with the
        split-key escrow.
      </div>
    </div>
  );
}

function CollectionsGovernance() {
  const [colls, setColls] = useState<CollectionSummary[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [members, setMembers] = useState<CollectionMember[] | null>(null);

  const load = () => Backend.Admin.listCollections().then(setColls).catch(() => setColls([]));
  useEffect(() => {
    load();
  }, []);

  const open = (id: string) => {
    setSel(id);
    setMembers(null);
    Backend.Admin.collectionMembers(id).then(setMembers).catch(() => setMembers([]));
  };
  const removeMember = async (id: string, userId: string) => {
    await Backend.Admin.removeCollectionMember(id, userId).catch(() => {});
    open(id);
    load();
  };
  const del = async (id: string) => {
    if (!window.confirm('Force-delete this collection for every member? Its encrypted machines are lost.')) return;
    await Backend.Admin.deleteCollection(id).catch(() => {});
    setSel(null);
    load();
  };

  const label = (id: string) => `Collection ${id.slice(0, 8)}`;

  if (sel) {
    return (
      <>
        <button onClick={() => setSel(null)} className="mb-4 flex items-center gap-1 text-sm font-semibold text-muted-foreground hover:text-foreground">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 6l-6 6 6 6" />
          </svg>
          Collections
        </button>
        <h1 className="mb-4 text-[22px] font-bold">{label(sel)}</h1>
        <div className="mb-4 overflow-hidden rounded-2xl border border-border bg-card">
          <div className="border-b border-border px-4 py-3 text-sm font-semibold">
            Members {members ? `· ${members.length}` : ''}
          </div>
          {members === null ? (
            <div className="px-4 py-4 text-sm text-muted-foreground">Loading…</div>
          ) : members.length === 0 ? (
            <div className="px-4 py-4 text-sm text-muted-foreground">No members.</div>
          ) : (
            members.map((m) => (
              <div key={m.userId} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
                <span className="flex-1 font-medium">{m.username}</span>
                <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-bold uppercase text-muted-foreground">{m.role}</span>
                <button onClick={() => removeMember(sel, m.userId)} className="rounded p-1 text-red-500 hover:bg-red-500/10" title="Remove member">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2M6 7l1 13a2 2 0 002 2h6a2 2 0 002-2l1-13" />
                  </svg>
                </button>
              </div>
            ))
          )}
        </div>
        <div className="flex items-center justify-between rounded-2xl border border-border bg-card px-4 py-3.5">
          <div>
            <div className="font-semibold text-red-500">Delete collection</div>
            <div className="text-xs text-muted-foreground">Force-remove it for every member. The encrypted machines are lost.</div>
          </div>
          <button onClick={() => del(sel)} className="rounded-md border border-red-500/40 px-3 py-1.5 text-sm font-medium text-red-500 hover:bg-red-500/10">
            Delete
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="mb-5">
        <h1 className="text-[22px] font-bold">Collections</h1>
        <span className="text-[13px] text-muted-foreground">Server-wide governance</span>
      </div>
      <ZkBanner />
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-4 border-b border-border px-4 py-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <span>Collection</span>
          <span className="text-right">Members</span>
          <span className="text-right">Machines</span>
          <span className="w-6" />
        </div>
        {colls === null ? (
          <div className="px-4 py-4 text-sm text-muted-foreground">Loading…</div>
        ) : colls.length === 0 ? (
          <div className="px-4 py-4 text-sm text-muted-foreground">No collections.</div>
        ) : (
          colls.map((c) => (
            <button
              key={c.id}
              onClick={() => open(c.id)}
              className="grid w-full grid-cols-[1fr_auto_auto_auto] items-center gap-4 border-b border-border px-4 py-3 text-left last:border-b-0 hover:bg-secondary"
            >
              <span className="flex items-center gap-2.5">
                <IconCollection className="h-4 w-4 text-primary" />
                <b>{label(c.id)}</b>
              </span>
              <span className="text-right text-sm">{c.memberCount}</span>
              <span className="text-right text-sm">{c.itemCount}</span>
              <svg className="h-4 w-4 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" />
              </svg>
            </button>
          ))
        )}
      </div>
    </>
  );
}
