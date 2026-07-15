/**
 * Admin account management (ADR 0010 phase 3).
 *
 * Visible to admins on a shared server. Lists accounts and creates/disables/
 * deletes them. New users' passwords are hashed on this device (Argon2id) before
 * being sent — the server never sees them, same as login. You cannot act on your
 * own account (the server also enforces this).
 */

import { useCallback, useEffect, useState } from 'react';
import { Backend, type ServerUser } from '../utils/backend';
import { useServerSession } from '../store/serverSessionStore';
import { deriveAuthHash, randomSaltHex, DEFAULT_KDF_PARAMS, createVaultKey } from '../utils/serverAuth';

export function AdminUsersPanel() {
  const { user: me } = useServerSession();
  const [users, setUsers] = useState<ServerUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'user' | 'admin'>('user');

  const refresh = useCallback(async () => {
    try {
      setUsers(await Backend.Admin.listUsers());
    } catch {
      setError('Failed to load users');
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async initial load
    refresh();
  }, [refresh]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const salt = randomSaltHex();
      // The admin knows the initial password, so it also builds the new user's
      // per-user vault key here (ADR 0011); the user should change it later.
      const [authHash, vaultKey] = await Promise.all([
        deriveAuthHash(password, salt, DEFAULT_KDF_PARAMS),
        createVaultKey(password),
      ]);
      await Backend.Admin.createUser(
        username.trim(),
        salt,
        DEFAULT_KDF_PARAMS,
        authHash,
        role,
        vaultKey.masterSaltHex,
        vaultKey.protectedUserKey,
      );
      setUsername('');
      setPassword('');
      setRole('user');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create user');
    } finally {
      setBusy(false);
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <h2 className="text-xl font-semibold">Users</h2>

      {error && (
        <div className="rounded-md border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-600">
          {error}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Username</th>
              <th className="px-4 py-2 font-medium">Role</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const isSelf = u.id === me?.id;
              return (
                <tr key={u.id} className="border-t border-border">
                  <td className="px-4 py-2">
                    {u.username}
                    {isSelf && <span className="ml-2 text-xs text-muted-foreground">(you)</span>}
                  </td>
                  <td className="px-4 py-2 uppercase">{u.role}</td>
                  <td className="px-4 py-2">
                    <span
                      className={
                        u.status === 'active' ? 'text-green-600' : 'text-muted-foreground'
                      }
                    >
                      {u.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right">
                    {!isSelf && (
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() =>
                            act(() =>
                              Backend.Admin.setStatus(
                                u.id,
                                u.status === 'active' ? 'disabled' : 'active',
                              ),
                            )
                          }
                          disabled={busy}
                          className="rounded border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
                        >
                          {u.status === 'active' ? 'Disable' : 'Enable'}
                        </button>
                        <button
                          onClick={() => act(() => Backend.Admin.deleteUser(u.id))}
                          disabled={busy}
                          className="rounded border border-red-500/30 px-2 py-1 text-xs text-red-600 hover:bg-red-500/10 disabled:opacity-50"
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <form
        onSubmit={handleCreate}
        className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-4"
      >
        <div className="flex-1 space-y-1">
          <label htmlFor="new-username" className="text-xs font-medium text-muted-foreground">
            Username
          </label>
          <input
            id="new-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            disabled={busy}
          />
        </div>
        <div className="flex-1 space-y-1">
          <label htmlFor="new-password" className="text-xs font-medium text-muted-foreground">
            Initial password
          </label>
          <input
            id="new-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            disabled={busy}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="new-role" className="text-xs font-medium text-muted-foreground">
            Role
          </label>
          <select
            id="new-role"
            value={role}
            onChange={(e) => setRole(e.target.value as 'user' | 'admin')}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm"
            disabled={busy}
          >
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
        </div>
        <button
          type="submit"
          disabled={busy || !username.trim() || !password}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          Add user
        </button>
      </form>
    </div>
  );
}
