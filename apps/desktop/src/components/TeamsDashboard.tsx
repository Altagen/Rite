/**
 * The user's teams surface at `/teams` (ADR 0016) — the teams I belong to (keyless
 * rosters), master-detail. For each team: its members with Manager/Member roles, the
 * collections offered to it (discovery — open if a member, request access if not), and
 * leave-team. Managing who's in a team is the org/team-admin console; this is the member's
 * view. Mirrors design/mock/teams.html.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Backend,
  type UserTeam,
  type TeamMember,
  type OfferedCollection,
} from '../utils/backend';
import { useServerSession } from '../store/serverSessionStore';
import { navigate } from '../store/route';
import { IconLock, IconUsers, IconCollection } from './icons';
import riteLogo from '../assets/rite.png';

const AVATAR_COLORS = ['#7c9cf5', '#9ece6a', '#e5b567', '#f0a35e', '#f7768e', '#bb9af7', '#56c7c0', '#e0af68'];
function avatarColor(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function Avatar({ name }: { name: string }) {
  return (
    <span
      className="grid h-7 w-7 flex-none place-items-center rounded-full text-[11px] font-bold text-black"
      style={{ backgroundColor: avatarColor(name) }}
      title={name}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
const roleLabel = (r: TeamMember['role']) => (r === 'admin' ? 'Manager' : 'Member');

export function TeamsDashboard() {
  const { user: me, mode, logout } = useServerSession();
  const [teams, setTeams] = useState<UserTeam[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [offered, setOffered] = useState<OfferedCollection[]>([]);
  const [requested, setRequested] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [mine, offers] = await Promise.all([
        Backend.Teams.mine(),
        Backend.Collections.offered().catch(() => [] as OfferedCollection[]),
      ]);
      setTeams(mine);
      setOffered(offers);
      setSelectedId((prev) => (prev && mine.some((t) => t.id === prev) ? prev : (mine[0]?.id ?? null)));
    } catch {
      setError('Failed to load teams');
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async initial load
    refresh();
  }, [refresh]);

  // Load the selected team's members.
  useEffect(() => {
    if (!selectedId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear on empty selection
      setMembers([]);
      return;
    }
    Backend.Teams.members(selectedId)
      .then(setMembers)
      .catch(() => setMembers([]));
  }, [selectedId]);

  const selected = teams.find((t) => t.id === selectedId) ?? null;
  const iManage = selected?.role === 'admin';
  const managerCount = useMemo(() => members.filter((m) => m.role === 'admin').length, [members]);
  const teamOffers = useMemo(
    () => (selected ? offered.filter((o) => o.teamId === selected.id) : []),
    [offered, selected],
  );

  const run = (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        await fn();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Action failed');
      } finally {
        setBusy(false);
      }
    })();
  };

  const leave = () => {
    if (!selected || !me) return;
    run(async () => {
      await Backend.Teams.removeMember(selected.id, me.id);
      await refresh();
    });
  };

  const request = (id: string) => {
    run(async () => {
      await Backend.Collections.requestAccess(id);
      setRequested((prev) => new Set(prev).add(id));
    });
  };

  // A member (not the last manager) can leave; the last manager is locked.
  const iAmLastManager = iManage && managerCount <= 1;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background text-foreground">
      <header className="m-appbar">
        <button onClick={() => navigate('/')} className="m-brand flex items-center gap-2.5" title="Back to the app">
          <img src={riteLogo} alt="Rite" className="h-[26px] rounded-[7px]" />
        </button>
        {mode?.instanceName && (
          <span className="m-chip" title="Server instance">
            <span className="m-dot" />
            {mode.instanceName}
          </span>
        )}
        <span className="m-spacer" />
        <button onClick={() => navigate('/')} className="m-btn m-btn-sm" title="Back to the app">
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
        {/* Rail: my teams */}
        <aside className="flex w-[280px] flex-none flex-col overflow-y-auto border-r border-border bg-input">
          <div className="px-3.5 pb-2 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            My teams
          </div>
          <div className="flex-1 px-2 pb-3">
            {teams.map((t) => (
              <button
                key={t.id}
                onClick={() => setSelectedId(t.id)}
                className={`flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left text-sm transition ${
                  selectedId === t.id ? 'border-primary/30 bg-primary/[0.13]' : 'border-transparent hover:bg-card'
                }`}
              >
                <IconUsers className="h-4 w-4 flex-none text-primary" />
                <span className="min-w-0 flex-1 truncate font-medium">{t.name}</span>
                {t.role === 'admin' && (
                  <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-bold uppercase text-primary">
                    Manager
                  </span>
                )}
              </button>
            ))}
            {teams.length === 0 && (
              <p className="px-2 py-3 text-sm text-muted-foreground">You&apos;re not in any team yet.</p>
            )}
          </div>
        </aside>

        {/* Detail */}
        <main className="min-w-0 flex-1 overflow-y-auto px-8 py-7">
          <div className="mx-auto max-w-[820px]">
            {error && (
              <div className="mb-4 rounded-md border border-red-500/20 bg-red-500/10 p-2 text-sm text-red-600">
                {error}
              </div>
            )}
            {!selected ? (
              <p className="text-sm text-muted-foreground">Select a team.</p>
            ) : (
              <>
                <div className="mb-1 flex items-center gap-3">
                  <IconUsers className="h-6 w-6 text-primary" />
                  <h1 className="text-2xl font-bold">{selected.name}</h1>
                  <span className="text-sm text-muted-foreground">· {members.length} members</span>
                </div>
                <p className="mb-5 text-sm text-muted-foreground">
                  {iManage
                    ? "You're a manager of this team. Sharing machines happens in collections."
                    : "You're a member of this team. Sharing machines happens in collections."}
                </p>

                {/* Members */}
                <section className="mb-4 overflow-hidden rounded-2xl border border-border bg-card">
                  <div className="border-b border-border px-4 py-3 text-sm font-semibold">
                    Members · {members.length}
                  </div>
                  {members.map((m) => (
                    <div key={m.userId} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
                      <Avatar name={m.username} />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {m.username}
                        {m.userId === me?.id && <span className="text-xs text-muted-foreground"> (you)</span>}
                      </span>
                      <span
                        className={`rounded-full px-2.5 py-1 text-xs font-semibold uppercase ${
                          m.role === 'admin' ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground'
                        }`}
                      >
                        {roleLabel(m.role)}
                      </span>
                    </div>
                  ))}
                </section>

                {/* Collections offered to this team (discovery) */}
                <section className="mb-4 overflow-hidden rounded-2xl border border-border bg-card">
                  <div className="border-b border-border px-4 py-3 text-sm font-semibold">
                    Collections offered to this team · {teamOffers.length}
                  </div>
                  {teamOffers.length === 0 ? (
                    <div className="px-4 py-3 text-sm text-muted-foreground">
                      No collections offered to this team yet.
                    </div>
                  ) : (
                    teamOffers.map((o) => {
                      const isMember = o.memberRole !== null;
                      const pending = requested.has(o.id);
                      return (
                        <div key={o.id} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
                          <IconCollection className="h-5 w-5 flex-none text-primary" />
                          <span className="min-w-0 flex-1 truncate text-sm font-medium">{o.discoveryLabel}</span>
                          {isMember ? (
                            <button
                              onClick={() => navigate('/collections')}
                              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-secondary"
                            >
                              Open
                            </button>
                          ) : pending ? (
                            <span className="rounded-full bg-amber-500/15 px-2.5 py-1 text-xs font-semibold uppercase text-amber-600">
                              Requested
                            </span>
                          ) : (
                            <button
                              onClick={() => request(o.id)}
                              disabled={busy}
                              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                            >
                              Request access
                            </button>
                          )}
                        </div>
                      );
                    })
                  )}
                </section>

                <div className="flex items-start gap-2.5 rounded-xl border border-primary/25 bg-primary/[0.08] p-3 text-xs text-foreground/80">
                  <IconLock className="mt-0.5 h-4 w-4 flex-none text-primary" />
                  <div>
                    <b>Names here are for discovery, not secrets.</b> The labels above are visible to this team (and the
                    server) so you can find and request access. The machines — and every private collection — stay
                    end-to-end encrypted; you only see them once a member grants you access.
                  </div>
                </div>

                {/* Leave team */}
                <section className="mt-4 flex items-center justify-between rounded-2xl border border-red-500/30 px-4 py-4">
                  <div>
                    <div className="text-sm font-semibold text-red-600">Leave team</div>
                    <div className="text-xs text-muted-foreground">
                      {iAmLastManager
                        ? 'You are the last manager — promote someone before leaving.'
                        : "You leave the roster and stop seeing the collections offered here. Collections you're already a member of are unaffected."}
                    </div>
                  </div>
                  <button
                    onClick={leave}
                    disabled={busy || iAmLastManager}
                    title={iAmLastManager ? 'the team needs at least one manager' : undefined}
                    className="rounded-md border border-red-500/40 px-3 py-1.5 text-sm text-red-600 hover:bg-red-500/10 disabled:opacity-50"
                  >
                    Leave
                  </button>
                </section>
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
