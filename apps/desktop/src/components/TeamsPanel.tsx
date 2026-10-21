/**
 * Team management (product-model.md RBAC). Org-admins create teams and manage
 * membership. Teams are keyless rosters (ADR 0016) — sharing lives in collections,
 * so there's no team key here; a member's role is 'admin' (Manager) or 'member'.
 */

import { useCallback, useEffect, useState } from 'react';
import { askConfirm } from '../utils/confirmPrompt';
import { Backend, type Team, type TeamMember, type ServerUser } from '../utils/backend';
import { useTranslation } from '../i18n/i18n';
import { useServerSession } from '../store/serverSessionStore';
import { DangerZone } from './DangerZone';
import { IconUsers } from './icons';

/**
 * Twenty-five a page.
 *
 * Sized for the control, not the data: a pager is useful while the page is one screenful,
 * and twenty-five rows is about that. The server clamps a request to 200, so a caller
 * cannot ask for the table back.
 */
const PER_PAGE = 25;

const roleLabel = (r: TeamMember['role'], t: (k: string) => string) =>
  r === 'admin' ? t('admin.teams.roleManager') : t('admin.teams.roleMember');

export function TeamsPanel() {
  const { t } = useTranslation();
  const { user: me } = useServerSession();
  const [teams, setTeams] = useState<Team[]>([]);
  const [total, setTotal] = useState(0);
  // The search is what is typed; `applied` is what was asked of the server. Debounced, so
  // typing six letters is one request rather than six.
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const [page, setPage] = useState(0);
  const [users, setUsers] = useState<ServerUser[]>([]);
  const [selected, setSelected] = useState<Team | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [newName, setNewName] = useState('');
  const [addUserId, setAddUserId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Load a page. The search and the cursor are arguments rather than read from state,
   * because a caller that has just changed them cannot see its own change yet: this is a
   * `useCallback`, so it closes over the values from the render that made it. Creating a
   * team cleared the search, called this, and loaded the page for the search it had just
   * cleared — so the new team was created and then filtered out of view.
   */
  const load = useCallback(
    async (query: string, at: number) => {
      try {
        const [teamPage, userList] = await Promise.all([
          Backend.Teams.page(query, PER_PAGE, at * PER_PAGE),
          Backend.Admin.listUsers(),
        ]);
        setTeams(teamPage.teams);
        setTotal(teamPage.total);
        setUsers(userList);
      } catch {
        setError(t('admin.teams.errLoad'));
      }
    },
    [t],
  );

  const refresh = useCallback(() => load(applied, page), [load, applied, page]);

  const loadMembers = useCallback(
    async (team: Team) => {
      setSelected(team);
      try {
        setMembers(await Backend.Teams.members(team.id));
      } catch {
        setError(t('admin.teams.errMembers'));
      }
    },
    [t],
  );

  useEffect(() => {
    const id = setTimeout(() => {
      setPage(0);
      setApplied(search.trim());
    }, 250);
    return () => clearTimeout(id);
  }, [search]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async initial load
    refresh();
  }, [refresh]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.teams.errAction'));
    } finally {
      setBusy(false);
    }
  };

  const createTeam = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || busy || !me) return;
    await act(async () => {
      const team = await Backend.Teams.create(newName.trim());
      // The creator joins as the first Manager (team role 'admin').
      await Backend.Teams.addMember(team.id, me.id, 'admin');
      setNewName('');
      // A new team under an active search would be created and then filtered away, which
      // reads as "nothing happened". Clear it and go back to the first page.
      setSearch('');
      setApplied('');
      setPage(0);
      await load('', 0);
    });
  };

  const nonMembers = users.filter((u) => !members.some((m) => m.userId === u.id));

  const pageCount = Math.max(1, Math.ceil(total / PER_PAGE));
  const safePage = Math.min(page, pageCount - 1);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <h2 className="text-xl font-semibold">{t('admin.teams.title')}</h2>

      {error && (
        <div className="rounded-md border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-600">
          {error}
        </div>
      )}

      {/* Creating comes first: it is what an empty console is for, and it used to sit under
          a list it could not be seen below. */}
      <form
        onSubmit={createTeam}
        className="flex items-end gap-3 rounded-lg border border-border bg-card p-4"
      >
        <div className="flex-1 space-y-1">
          <label htmlFor="new-team" className="text-xs font-medium text-muted-foreground">
            {t('admin.teams.newName')}
          </label>
          <input
            id="new-team"
            data-testid="new-team-name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            disabled={busy}
          />
        </div>
        <button
          type="submit"
          data-testid="new-team-submit"
          disabled={busy || !newName.trim()}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('admin.teams.create')}
        </button>
      </form>

      {/* Search and the page are the server's: a directory of a few thousand groups cannot
          be filtered in the browser, because it was never all sent here. */}
      <div className="flex items-center gap-3">
        <input
          type="search"
          data-testid="team-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('admin.teams.searchPlaceholder')}
          className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
        <span className="flex-none text-xs text-muted-foreground" data-testid="team-total">
          {applied
            ? t('admin.teams.matching', { count: total })
            : t('admin.teams.countTotal', { count: total })}
        </span>
      </div>

      {/* One per row, not chips in a wrapping line: a row can carry the name and its member
          count, and fifty rows scroll where fifty chips become a wall. */}
      <div className="overflow-hidden rounded-lg border border-border" data-testid="team-list">
        {teams.map((team) => (
          <button
            key={team.id}
            data-testid={`team-${team.name}`}
            onClick={() => loadMembers(team)}
            className={`flex w-full items-center gap-3 border-b border-border px-3.5 py-2.5 text-left text-sm last:border-b-0 ${
              selected?.id === team.id ? 'bg-primary/10 font-medium' : 'hover:bg-muted'
            }`}
          >
            <IconUsers className="h-4 w-4 flex-none text-primary" />
            <span className="min-w-0 flex-1 truncate">{team.name}</span>
          </button>
        ))}
        {teams.length === 0 && (
          <p className="px-3.5 py-4 text-sm text-muted-foreground">
            {applied ? t('admin.teams.noMatch', { query: applied }) : t('admin.teams.none')}
          </p>
        )}
      </div>

      {pageCount > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">
            {t('admin.teams.page', { page: safePage + 1, total: pageCount })}
          </span>
          <div className="flex gap-2">
            <button
              data-testid="team-prev"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={safePage === 0}
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-40"
            >
              {t('notif.prev')}
            </button>
            <button
              data-testid="team-next"
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              disabled={safePage >= pageCount - 1}
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-40"
            >
              {t('notif.next')}
            </button>
          </div>
        </div>
      )}

      {selected && (
        <div className="space-y-4 rounded-lg border border-border p-4">
          <h3 className="font-medium">{selected.name}</h3>

          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1 font-medium">{t('admin.teams.colMember')}</th>
                <th className="py-1 font-medium">{t('admin.teams.colRole')}</th>
                <th className="py-1 font-medium text-right">{t('admin.teams.colActions')}</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.userId} className="border-t border-border">
                  <td className="py-1.5">{m.username}</td>
                  <td className="py-1.5">{roleLabel(m.role, t)}</td>
                  <td className="py-1.5">
                    <div className="flex justify-end gap-2">
                      {m.userId !== me?.id && (
                        <button
                          onClick={() =>
                            act(async () => {
                              await Backend.Teams.removeMember(selected.id, m.userId);
                              await loadMembers(selected);
                            })
                          }
                          disabled={busy}
                          className="rounded border border-red-500/30 px-2 py-0.5 text-xs text-red-600 hover:bg-red-500/10 disabled:opacity-50"
                        >
                          {t('admin.teams.remove')}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="flex items-end gap-3">
            <div className="flex-1 space-y-1">
              <label htmlFor="add-member" className="text-xs font-medium text-muted-foreground">
                {t('admin.teams.addMember')}
              </label>
              <select
                id="add-member"
                value={addUserId}
                onChange={(e) => setAddUserId(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                disabled={busy || nonMembers.length === 0}
              >
                <option value="">{t('admin.teams.pickUser')}</option>
                {nonMembers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.username}
                  </option>
                ))}
              </select>
            </div>
            <button
              onClick={() =>
                addUserId &&
                act(async () => {
                  await Backend.Teams.addMember(selected.id, addUserId, 'member');
                  setAddUserId('');
                  await loadMembers(selected);
                })
              }
              disabled={busy || !addUserId}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {t('admin.teams.add')}
            </button>
          </div>

          <DangerZone
            title={t('admin.teams.deleteTeam')}
            desc={t('admin.teams.deleteDesc')}
            action={t('admin.teams.deleteAction')}
            disabled={busy}
            onAction={() =>
              // Destructive and irreversible: the roster is gone and every member has to be
              // added back by hand. It used to delete on the first click.
              void (async () => {
                const ok = await askConfirm({
                  title: t('admin.teams.confirmDeleteTitle', { name: selected.name }),
                  body: t('admin.teams.confirmDelete', { count: members.length }),
                  action: t('admin.teams.deleteAction'),
                  danger: true,
                });
                if (!ok) return;
                await act(async () => {
                  await Backend.Teams.remove(selected.id);
                  setSelected(null);
                  setMembers([]);
                  await refresh();
                });
              })()
            }
          />
        </div>
      )}
    </div>
  );
}
