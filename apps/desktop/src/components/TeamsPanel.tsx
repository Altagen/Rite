/**
 * Team management (product-model.md RBAC + ADR 0013 team key sharing).
 *
 * Org-admins create teams and manage membership; a team's crypto is set up
 * client-side: creating a team generates a team key sealed to the creator (they
 * become the first key-holder), and granting a member seals the team key to their
 * public key. The server only ever stores sealed blobs it can't open.
 */

import { useCallback, useEffect, useState } from 'react';
import { Backend, type Team, type TeamMember, type ServerUser } from '../utils/backend';
import { useServerSession } from '../store/serverSessionStore';
import { generateTeamKey, sealTeamKey, sealTeamKeyToHex, unwrapTeamKey } from '../utils/teamCrypto';

export function TeamsPanel() {
  const { user: me, publicKey, privateKey } = useServerSession();
  const [teams, setTeams] = useState<Team[]>([]);
  const [users, setUsers] = useState<ServerUser[]>([]);
  const [myKeys, setMyKeys] = useState<Record<string, string | null>>({}); // teamId → my sealed key
  const [selected, setSelected] = useState<Team | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [newName, setNewName] = useState('');
  const [addUserId, setAddUserId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [teamList, userList, mine] = await Promise.all([
        Backend.Teams.listAll(),
        Backend.Admin.listUsers(),
        Backend.Teams.mine(),
      ]);
      setTeams(teamList);
      setUsers(userList);
      setMyKeys(Object.fromEntries(mine.map((t) => [t.id, t.protectedTeamKey ?? null])));
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
    if (!newName.trim() || busy || !me || !publicKey) return;
    await act(async () => {
      const team = await Backend.Teams.create(newName.trim());
      // Initialize the team key: generate it and seal it to myself (first key-holder).
      const teamKey = generateTeamKey();
      await Backend.Teams.addMember(team.id, me.id, 'admin');
      await Backend.Teams.grantKey(team.id, me.id, await sealTeamKey(publicKey, teamKey));
      setNewName('');
      await refresh();
    });
  };

  const grantKey = async (member: TeamMember) => {
    if (!selected || !publicKey || !privateKey) return;
    const sealed = myKeys[selected.id];
    if (!sealed || !member.publicKey) return;
    await act(async () => {
      const teamKey = await unwrapTeamKey(publicKey, privateKey, sealed);
      const forMember = await sealTeamKeyToHex(member.publicKey!, teamKey);
      await Backend.Teams.grantKey(selected.id, member.userId, forMember);
      await loadMembers(selected);
    });
  };

  const iHoldKey = selected ? !!myKeys[selected.id] : false;
  const nonMembers = users.filter((u) => !members.some((m) => m.userId === u.id));

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <h2 className="text-xl font-semibold">Teams</h2>

      {error && (
        <div className="rounded-md border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-600">
          {error}
        </div>
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
            <h3 className="font-medium">
              {selected.name}
              {!iHoldKey && (
                <span className="ml-2 text-xs text-amber-600">you don't hold this team's key</span>
              )}
            </h3>
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
                <th className="py-1 font-medium">Key</th>
                <th className="py-1 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.userId} className="border-t border-border">
                  <td className="py-1.5">{m.username}</td>
                  <td className="py-1.5 uppercase">{m.role}</td>
                  <td className="py-1.5">
                    {m.hasKey ? (
                      <span className="text-green-600">granted</span>
                    ) : (
                      <span className="text-muted-foreground">no access</span>
                    )}
                  </td>
                  <td className="py-1.5">
                    <div className="flex justify-end gap-2">
                      {!m.hasKey && (
                        <button
                          onClick={() => grantKey(m)}
                          disabled={busy || !iHoldKey || !m.publicKey}
                          title={iHoldKey ? 'Seal the team key to this member' : 'You are not a key-holder'}
                          className="rounded border border-border px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-50"
                        >
                          Grant key
                        </button>
                      )}
                      {m.hasKey && m.userId !== me?.id && (
                        <button
                          onClick={() => act(async () => {
                            await Backend.Teams.revokeKey(selected.id, m.userId);
                            await loadMembers(selected);
                          })}
                          disabled={busy}
                          className="rounded border border-border px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-50"
                        >
                          Revoke
                        </button>
                      )}
                      {m.userId !== me?.id && (
                        <button
                          onClick={() => act(async () => {
                            await Backend.Teams.removeMember(selected.id, m.userId);
                            await loadMembers(selected);
                          })}
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
