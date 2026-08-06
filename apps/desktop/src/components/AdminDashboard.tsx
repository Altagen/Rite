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
import {
  Backend,
  type ServerUser,
  type CollectionSummary,
  type CollectionMember,
  type CollectionPolicy,
  type DirectoryEntry,
} from '../utils/backend';
import {
  ensureGroupKey,
  myGroupPrivateKey,
  unsealMetaKey,
  decryptName,
  type GroupKey,
} from '../utils/adminGroup';
import { sealCollectionKeyToHex } from '../utils/collectionCrypto';
import { AdminUsersPanel } from './AdminUsersPanel';
import { InvitationsPanel } from './InvitationsPanel';
import { TeamsPanel } from './TeamsPanel';
import { InstanceSettingsPanel } from './InstanceSettingsPanel';
import { IconUsers, IconShield, IconGear, IconLock, IconCollection } from './icons';
import { isNativeShell } from '../utils/nativeShell';
import riteLogo from '../assets/rite.png';

type Sec = 'overview' | 'users' | 'invitations' | 'teams' | 'collections' | 'instance';
type Role = 'admin' | 'manager' | 'user';

// Sections are gated on TWO axes: the account role (managers do org only — users + teams), and the
// shell (the desktop client hides heavy INSTANCE administration, which lives in the web console —
// Bitwarden/Vaultwarden model). The API guard is the real boundary; this is UX.
const NAV: { id: Sec; label: string; icon: React.ReactNode; roles: Role[]; webOnly?: boolean }[] = [
  { id: 'overview', label: 'Overview', icon: <IconGrid />, roles: ['admin'], webOnly: true },
  { id: 'users', label: 'Users', icon: <IconUsers className="h-4 w-4" />, roles: ['admin', 'manager'] },
  { id: 'invitations', label: 'Invitations', icon: <IconTicket />, roles: ['admin', 'manager'] },
  { id: 'teams', label: 'Teams', icon: <IconUsers className="h-4 w-4" />, roles: ['admin', 'manager'] },
  { id: 'collections', label: 'Collections', icon: <IconCollection className="h-4 w-4" />, roles: ['admin'] },
  { id: 'instance', label: 'Instance', icon: <IconGear className="h-4 w-4" />, roles: ['admin'], webOnly: true },
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

function IconTicket() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l9 5 9-5" />
      <rect x="3" y="6" width="18" height="12" rx="1.5" />
    </svg>
  );
}

export function AdminDashboard({ hideBack = false }: { hideBack?: boolean } = {}) {
  const { mode, logout, user } = useServerSession();
  const role = (user?.role ?? 'user') as Role;
  const native = isNativeShell();
  // Visible sections = allowed by role AND by shell (native hides web-only instance admin).
  const nav = NAV.filter((n) => n.roles.includes(role) && (!native || !n.webOnly));
  // Default to an always-visible section; the nav only offers visible ones, so `sec` stays valid.
  const [sec, setSec] = useState<Sec>(nav[0]?.id ?? 'teams');
  // "Admin" only for a full admin on the web console; otherwise it's the org surface.
  const label = role === 'admin' && !native ? 'Admin' : 'Organization';
  // Some sections are hidden here (native shell, or a manager) ⇒ point instance admin at the web.
  const hasHidden = nav.length < NAV.filter((n) => n.roles.includes(role)).length || native;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background text-foreground">
      {/* Top bar — a distinct admin surface */}
      <header className="m-appbar">
        <div className="m-brand flex items-center gap-2.5">
          <img src={riteLogo} alt="Rite" className="h-[26px] rounded-[7px]" />
          <span className="rounded-md border border-primary/40 px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-primary">
            {label}
          </span>
        </div>
        {mode?.instanceName && (
          <span className="m-chip" title="Server instance">
            <span className="m-dot" />
            {mode.instanceName}
          </span>
        )}
        <span className="m-spacer" />
        {!hideBack && (
          <button onClick={() => navigate('/')} className="m-btn m-btn-sm" title="Back to the connection manager">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 6l-6 6 6 6" />
            </svg>
            <span className="hidden md:inline">Back to app</span>
          </button>
        )}
        <button onClick={() => logout()} className="m-btn m-btn-ghost m-btn-sm" title="Sign out">
          <IconLock className="h-4 w-4" />
          <span className="hidden md:inline">Sign out</span>
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Left nav */}
        <nav className="flex w-[220px] flex-shrink-0 flex-col gap-0.5 border-r border-border bg-input p-2.5">
          {nav.map((n) => (
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
          {hasHidden && (
            <p className="mt-auto px-2 pt-3 text-[11px] leading-relaxed text-muted-foreground">
              {native
                ? 'Server settings live in the web console — open the server URL in a browser.'
                : 'Instance administration is limited to admins.'}
            </p>
          )}
        </nav>

        {/* Content — the nav only offers sections this role+shell may see; guard the panels too. */}
        <main className="min-w-0 flex-1 overflow-y-auto px-8 py-7">
          <div className="mx-auto max-w-[1400px]">
            {nav.some((n) => n.id === sec) && (
              <>
                {sec === 'overview' && <Overview onGo={setSec} />}
                {sec === 'users' && <AdminUsersPanel />}
                {sec === 'invitations' && <InvitationsPanel />}
                {sec === 'teams' && <TeamsPanel />}
                {sec === 'collections' && <CollectionsGovernance />}
                {sec === 'instance' && <InstanceSettingsPanel />}
              </>
            )}
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

function activityAgo(seconds: number): string {
  const d = Math.floor(Date.now() / 1000) - seconds;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 604800) return `${Math.floor(d / 86400)}d ago`;
  return new Date(seconds * 1000).toLocaleDateString();
}

function Overview({ onGo }: { onGo: (s: Sec) => void }) {
  const [users, setUsers] = useState<ServerUser[] | null>(null);
  useEffect(() => {
    Backend.Admin.listUsers().then(setUsers).catch(() => setUsers([]));
  }, []);
  const admins = users?.filter((u) => u.role === 'admin').length ?? 0;
  const active = users?.filter((u) => u.status === 'active').length ?? 0;
  // Recent activity, derived from real data we already hold (account creations). A fuller
  // audit trail (sign-ins, grants, leaves) would need server-side event logging — future work.
  const recent = [...(users ?? [])].sort((a, b) => b.createdAt - a.createdAt).slice(0, 6);

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

      <div className="mt-6 overflow-hidden rounded-2xl border border-border bg-card">
        <div className="border-b border-border px-4 py-3 text-sm font-semibold">Recent activity</div>
        {users === null ? (
          <div className="px-4 py-4 text-sm text-muted-foreground">Loading…</div>
        ) : recent.length === 0 ? (
          <div className="px-4 py-4 text-sm text-muted-foreground">No activity yet.</div>
        ) : (
          recent.map((u) => (
            <div key={u.id} className="flex items-center gap-3 border-b border-border px-4 py-2.5 text-sm last:border-b-0">
              <span className="grid h-7 w-7 flex-none place-items-center rounded-full bg-primary/15 text-xs font-semibold uppercase text-primary">
                {u.username.slice(0, 2)}
              </span>
              <span className="min-w-0 flex-1">
                <b>{u.username}</b> <span className="text-muted-foreground">joined</span>
              </span>
              <span className="flex-none text-muted-foreground">{activityAgo(u.createdAt)}</span>
            </div>
          ))
        )}
      </div>
    </>
  );
}

function ZkBanner() {
  return (
    <div className="mb-5 flex items-start gap-2.5 rounded-xl border border-primary/25 bg-primary/[0.08] p-3.5 text-[13px] text-foreground/80">
      <IconShield className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" />
      <div>
        <b>Zero-knowledge.</b> The server never sees a key. Collection <b>names</b> are readable here only through the
        Admin-group escrow — machine credentials stay sealed to members and are never shown. Collections created before
        the escrow existed appear by id until re-keyed. You can decrypt names, remove a member, delete a collection, and
        grant a member <b>name/roster</b> access; full <b>machine</b> access still needs a member to seal the item key.
      </div>
    </div>
  );
}

interface CollName {
  name: string;
  color: string | null;
}

const DEFAULT_COLL_POLICY: CollectionPolicy = {
  allowCreate: true,
  allowSharingOutsideTeams: true,
  maxMembers: 0,
  defaultRole: 'viewer',
};

function PolicyToggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={onClick}
      className={`relative h-6 w-11 flex-none rounded-full transition-colors ${on ? 'bg-primary' : 'bg-muted'}`}
    >
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${on ? 'translate-x-5' : 'translate-x-0.5'}`} />
    </button>
  );
}

/** Server-wide collection governance (mock admin → Collections): who may create, share, how
 *  many members, and the default role. Optimistic saves; reverts on failure. */
function CollectionPolicyPanel() {
  const [p, setP] = useState<CollectionPolicy>(DEFAULT_COLL_POLICY);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    Backend.Server.mode()
      .then((m) => setP(m.collectionPolicy ?? DEFAULT_COLL_POLICY))
      .catch(() => {});
  }, []);
  const save = async (next: CollectionPolicy) => {
    const prev = p;
    setP(next);
    setErr(null);
    try {
      await Backend.Admin.setCollectionPolicy(next);
    } catch (e) {
      setP(prev);
      setErr(e instanceof Error ? e.message : 'Failed to save');
    }
  };
  const row = 'flex flex-wrap items-center justify-between gap-4 border-t border-border p-4 first:border-t-0';
  return (
    <div className="mb-4 overflow-hidden rounded-2xl border border-border bg-card">
      {err && <div className="border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-600">{err}</div>}
      <div className={row}>
        <div>
          <div className="font-medium">Allow users to create collections</div>
          <p className="mt-1 text-sm text-muted-foreground">When off, only admins provision collections.</p>
        </div>
        <PolicyToggle on={p.allowCreate} onClick={() => save({ ...p, allowCreate: !p.allowCreate })} />
      </div>
      <div className={row}>
        <div>
          <div className="font-medium">Allow sharing outside teams</div>
          <p className="mt-1 text-sm text-muted-foreground">Members can add anyone in the directory, not just teammates.</p>
        </div>
        <PolicyToggle
          on={p.allowSharingOutsideTeams}
          onClick={() => save({ ...p, allowSharingOutsideTeams: !p.allowSharingOutsideTeams })}
        />
      </div>
      <div className={row}>
        <div>
          <div className="font-medium">Max members per collection</div>
          <p className="mt-1 text-sm text-muted-foreground">0 = unlimited.</p>
        </div>
        <input
          type="number"
          min={0}
          value={p.maxMembers}
          onChange={(e) => setP({ ...p, maxMembers: Math.max(0, Number(e.target.value) || 0) })}
          onBlur={() => save(p)}
          className="w-20 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
        />
      </div>
      <div className={row}>
        <div>
          <div className="font-medium">Default role for new members</div>
          <p className="mt-1 text-sm text-muted-foreground">Applied when someone is added to a collection.</p>
        </div>
        <select
          value={p.defaultRole}
          onChange={(e) => save({ ...p, defaultRole: e.target.value as CollectionPolicy['defaultRole'] })}
          className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
        >
          <option value="viewer">viewer</option>
          <option value="editor">editor</option>
        </select>
      </div>
    </div>
  );
}

function CollectionsGovernance() {
  const { publicKey, privateKey } = useServerSession();
  const [colls, setColls] = useState<CollectionSummary[] | null>(null);
  const [names, setNames] = useState<Map<string, CollName>>(new Map());
  const [sel, setSel] = useState<string | null>(null);
  const [members, setMembers] = useState<CollectionMember[] | null>(null);
  // The Admin-group keypair held for this session, used to unseal metaKeys (names) and
  // to re-seal them when roster-adding a member. Never touches item keys.
  const [group, setGroup] = useState<GroupKey | null>(null);
  const [secret, setSecret] = useState<Uint8Array | null>(null);
  const [directory, setDirectory] = useState<DirectoryEntry[]>([]);
  const [addTarget, setAddTarget] = useState('');

  // Load the collections and, via the Admin-group escrow, decrypt the names admins
  // are allowed to see. Machine credentials stay sealed to members — never decrypted
  // here. Un-escrowed collections keep the "Collection <id>" fallback.
  const load = async () => {
    const all = await Backend.Admin.listCollections().catch(() => [] as CollectionSummary[]);
    setColls(all);
    if (!publicKey || !privateKey) return;
    const g = await ensureGroupKey().catch(() => null);
    if (!g) return;
    const sec = await myGroupPrivateKey(publicKey, privateKey).catch(() => null);
    if (!sec) return;
    setGroup(g);
    setSecret(sec);
    Backend.Collections.directory().then(setDirectory).catch(() => setDirectory([]));
    const map = new Map<string, CollName>();
    for (const c of all) {
      if (!c.metaKeyGroupEnc) continue;
      try {
        const metaKey = await unsealMetaKey(g, sec, c.metaKeyGroupEnc);
        map.set(c.id, await decryptName<CollName>(metaKey, c.nameEnc));
      } catch {
        // wrong epoch / undecryptable — leave the id fallback
      }
    }
    setNames(map);
  };
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async initial load
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keys are stable per session
  }, []);

  const open = (id: string) => {
    setSel(id);
    setMembers(null);
    setAddTarget('');
    Backend.Admin.collectionMembers(id).then(setMembers).catch(() => setMembers([]));
  };
  const removeMember = async (id: string, userId: string) => {
    await Backend.Admin.removeCollectionMember(id, userId).catch(() => {});
    open(id);
    load();
  };

  // Roster meta-add: grant a user name/roster access to an escrowed collection by
  // re-sealing its metaKey to them. Machine access still needs a member to seal the
  // itemsKey — the admin never holds it.
  const addMemberMeta = async (id: string, userId: string) => {
    const coll = colls?.find((c) => c.id === id);
    const entry = directory.find((d) => d.id === userId);
    if (!coll?.metaKeyGroupEnc || !group || !secret || !entry?.publicKey) return;
    try {
      const metaKey = await unsealMetaKey(group, secret, coll.metaKeyGroupEnc);
      await Backend.Admin.addCollectionMemberMeta(id, userId, await sealCollectionKeyToHex(entry.publicKey, metaKey));
      setAddTarget('');
      open(id);
    } catch {
      // sealing failed (bad key / not escrowed) — leave the roster unchanged
    }
  };
  const del = async (id: string) => {
    if (!window.confirm('Force-delete this collection for every member? Its encrypted machines are lost.')) return;
    await Backend.Admin.deleteCollection(id).catch(() => {});
    setSel(null);
    load();
  };

  const label = (id: string) => names.get(id)?.name ?? `Collection ${id.slice(0, 8)}`;

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
        {(() => {
          const selColl = colls?.find((c) => c.id === sel);
          const canAdd = !!selColl?.metaKeyGroupEnc && !!group && !!secret;
          const taken = new Set((members ?? []).map((m) => m.userId));
          const candidates = directory.filter((d) => !taken.has(d.id) && d.publicKey);
          return (
            <div className="mb-4 rounded-2xl border border-border bg-card p-4">
              <div className="text-sm font-semibold">Grant name / roster access</div>
              <p className="mb-3 mt-0.5 text-xs text-muted-foreground">
                {canAdd
                  ? 'Adds the user to the roster and lets them see the collection name. Machine access still needs a member to seal the item key.'
                  : 'Available once the collection is escrowed to the Admin group (created after the escrow, or re-keyed).'}
              </p>
              <div className="flex items-center gap-2">
                <select
                  value={addTarget}
                  onChange={(e) => setAddTarget(e.target.value)}
                  disabled={!canAdd || candidates.length === 0}
                  className="min-w-0 flex-1 rounded-md border border-border bg-input px-2.5 py-1.5 text-sm disabled:opacity-50"
                >
                  <option value="">
                    {candidates.length === 0 ? 'No users to add' : 'Select a user…'}
                  </option>
                  {candidates.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.username}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => addTarget && addMemberMeta(sel, addTarget)}
                  disabled={!canAdd || !addTarget}
                  className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  Add
                </button>
              </div>
            </div>
          );
        })()}
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
      <CollectionPolicyPanel />
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
