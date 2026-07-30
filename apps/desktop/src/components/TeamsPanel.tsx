/**
 * Team management (product-model.md RBAC). Org-admins create teams and manage
 * membership. Teams are keyless rosters (ADR 0016) — sharing lives in collections,
 * so there's no team key here; a member's role is 'admin' (Manager) or 'member'.
 */

import { useCallback, useEffect, useState } from 'react';
import { Backend, type Team, type TeamMember, type ServerUser } from '../utils/backend';
import { useServerSession } from '../store/serverSessionStore';

const roleLabel = (r: TeamMember['role']) => (r === 'admin' ? 'Manager' : 'Member');

export function TeamsPanel() {
  const { user: me } = useServerSession();
  const [teams, setTeams] = useState<Team[]>([]);
  const [users, setUsers] = useState<ServerUser[]>([]);
  const [selected, setSelected] = useState<Team | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [newName, setNewName] = useState('');
  const [addUserId, setAddUserId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [teamList, userList] = await Promise.all([Backend.Teams.listAll(), Backend.Admin.listUsers()]);
      setTeams(teamList);
      setUsers(userList);
    } catch {
      setError('Failed to load teams');
    }
  }, []);

  const loadMembers = useCallback(async (team: Team) => {
    setSelected(team);
    try {
      setMembers(await Backend.Teams.members(team.id));
    } catch {
      setError('Failed to load members');
    }
  }, []);

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
      setError(err instanceof Error ? err.message : 'Action failed');
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
      await refresh();
    });
  };

  const nonMembers = users.filter((u) => !members.some((m) => m.userId === u.id));

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <h2 className="text-xl font-semibold">Teams</h2>

      {error && (
        <div className="rounded-md border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-600">{error}</div>
      )}

      <div className="flex flex-wrap gap-2">
        {teams.map((t) => (
          <button
            key={t.id}
            onClick={() => loadMembers(t)}
            className={`rounded-md border px-3 py-1.5 text-sm ${
              selected?.id === t.id ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted'
            }`}
          >
            {t.name}
          </button>
        ))}
        {teams.length === 0 && <p className="text-sm text-muted-foreground">No teams yet.</p>}
      </div>

      <form onSubmit={createTeam} className="flex items-end gap-3 rounded-lg border border-border bg-card p-4">
        <div className="flex-1 space-y-1">
          <label htmlFor="new-team" className="text-xs font-medium text-muted-foreground">
            New team name
          </label>
          <input
            id="new-team"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            disabled={busy}
          />
        </div>
        <button
          type="submit"
          disabled={busy || !newName.trim()}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          Create team
        </button>
      </form>

      {selected && (
        <div className="space-y-4 rounded-lg border border-border p-4">
          <div className="flex items-center justify-between">
            <h3 className="font-medium">{selected.name}</h3>
            <button
              onClick={() =>
                act(async () => {
                  await Backend.Teams.remove(selected.id);
                  setSelected(null);
                  setMembers([]);
                  await refresh();
                })
              }
              disabled={busy}
              className="rounded border border-red-500/30 px-2 py-1 text-xs text-red-600 hover:bg-red-500/10 disabled:opacity-50"
            >
              Delete team
            </button>
          </div>

          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1 font-medium">Member</th>
                <th className="py-1 font-medium">Role</th>
                <th className="py-1 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.userId} className="border-t border-border">
                  <td className="py-1.5">{m.username}</td>
                  <td className="py-1.5">{roleLabel(m.role)}</td>
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
                          Remove
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
                Add member
              </label>
              <select
                id="add-member"
                value={addUserId}
                onChange={(e) => setAddUserId(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                disabled={busy || nonMembers.length === 0}
              >
                <option value="">Select a user…</option>
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
              Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
