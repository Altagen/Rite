/**
 * Team shared connections (ADR 0013 phase 4b).
 *
 * A member sees the connections shared within their teams, decrypted **in the
 * browser** with the team key (the server only ever stores sealed blobs). They can
 * add or remove shared connections. Only teams the user holds a key for appear —
 * without the key the blobs are unreadable. Opening a shared connection (a
 * terminal) is a separate UX track, not wired here yet.
 */

import { useCallback, useEffect, useState } from 'react';
import { Backend, type UserTeam } from '../utils/backend';
import { useServerSession } from '../store/serverSessionStore';
import { unwrapTeamKey, encryptTeamConnection, decryptTeamConnection } from '../utils/teamCrypto';

interface TeamConn {
  name: string;
  hostname: string;
  port: number;
  username: string;
  authMethod: { type: 'password'; password: string };
}
interface Row {
  id: string;
  conn: TeamConn;
}

export function TeamConnectionsPanel() {
  const { publicKey, privateKey } = useServerSession();
  const [teams, setTeams] = useState<UserTeam[]>([]);
  const [selected, setSelected] = useState<UserTeam | null>(null);
  const [teamKey, setTeamKey] = useState<Uint8Array | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [form, setForm] = useState({ name: '', hostname: '', port: '22', username: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadTeams = useCallback(async () => {
    try {
      // Only teams the user holds a key for can be decrypted.
      setTeams((await Backend.Teams.mine()).filter((t) => t.protectedTeamKey));
    } catch {
      setError('Failed to load teams');
    }
  }, []);

  const openTeam = useCallback(
    async (team: UserTeam) => {
      if (!publicKey || !privateKey || !team.protectedTeamKey) return;
      setSelected(team);
      setError(null);
      try {
        const key = await unwrapTeamKey(publicKey, privateKey, team.protectedTeamKey);
        setTeamKey(key);
        const blobs = await Backend.Teams.connections(team.id);
        setRows(
          await Promise.all(
            blobs.map(async (b) => ({ id: b.id, conn: await decryptTeamConnection<TeamConn>(key, b.blob) })),
          ),
        );
      } catch {
        setError('Failed to decrypt team connections');
      }
    },
    [publicKey, privateKey],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async initial load
    loadTeams();
  }, [loadTeams]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected || !teamKey || !form.name.trim() || !form.hostname.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const conn: TeamConn = {
        name: form.name.trim(),
        hostname: form.hostname.trim(),
        port: Number(form.port) || 22,
        username: form.username.trim(),
        authMethod: { type: 'password', password: form.password },
      };
      const blob = await encryptTeamConnection(teamKey, {
        ...conn,
        protocol: 'ssh',
        color: null,
        icon: null,
        folder: null,
        notes: null,
        sshKeepAliveOverride: null,
        sshKeepAliveInterval: null,
      });
      await Backend.Teams.createConnection(selected.id, blob);
      setForm({ name: '', hostname: '', port: '22', username: '', password: '' });
      await openTeam(selected);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add connection');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <h2 className="text-xl font-semibold">Team connections</h2>

      {error && (
        <div className="rounded-md border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-600">
          {error}
        </div>
      )}

      {teams.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          You have no team with a granted key yet. Shared connections appear once a team admin grants
          you the team key.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {teams.map((t) => (
            <button
              key={t.id}
              onClick={() => openTeam(t)}
              className={`rounded-md border px-3 py-1.5 text-sm ${
                selected?.id === t.id ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted'
              }`}
            >
              {t.name}
            </button>
          ))}
        </div>
      )}

      {selected && teamKey && (
        <div className="space-y-4 rounded-lg border border-border p-4">
          <h3 className="font-medium">{selected.name}</h3>
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1 font-medium">Name</th>
                <th className="py-1 font-medium">Target</th>
                <th className="py-1 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="py-1.5">{r.conn.name}</td>
                  <td className="py-1.5 text-muted-foreground">
                    {r.conn.username}@{r.conn.hostname}:{r.conn.port}
                  </td>
                  <td className="py-1.5 text-right">
                    <button
                      onClick={async () => {
                        setBusy(true);
                        try {
                          await Backend.Teams.deleteConnection(selected.id, r.id);
                          await openTeam(selected);
                        } finally {
                          setBusy(false);
                        }
                      }}
                      disabled={busy}
                      className="rounded border border-red-500/30 px-2 py-0.5 text-xs text-red-600 hover:bg-red-500/10 disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={3} className="py-2 text-muted-foreground">
                    No shared connections yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <form onSubmit={add} className="flex flex-wrap items-end gap-3">
            {(
              [
                ['name', 'Name', 'text'],
                ['hostname', 'Host', 'text'],
                ['port', 'Port', 'number'],
                ['username', 'User', 'text'],
                ['password', 'Password', 'password'],
              ] as const
            ).map(([k, label, type]) => (
              <div key={k} className="space-y-1">
                <label htmlFor={`tc-${k}`} className="text-xs font-medium text-muted-foreground">
                  {label}
                </label>
                <input
                  id={`tc-${k}`}
                  type={type}
                  value={form[k]}
                  onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                  className={`rounded-md border border-input bg-background px-3 py-2 text-sm ${
                    k === 'port' ? 'w-20' : 'w-36'
                  }`}
                  disabled={busy}
                />
              </div>
            ))}
            <button
              type="submit"
              disabled={busy || !form.name.trim() || !form.hostname.trim()}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              Add
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
