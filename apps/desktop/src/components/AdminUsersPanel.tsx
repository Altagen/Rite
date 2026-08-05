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
import { ensureGroupKey, myGroupPrivateKey, rotateGroup, grantToAdmin } from '../utils/adminGroup';

export function AdminUsersPanel() {
  const { user: me, publicKey, privateKey } = useServerSession();

  // Removing an admin must cut their FUTURE access to escrowed collection names:
  // rotate the Admin group (fresh epoch, re-seal every escrow, re-grant the remaining
  // admins). Done here by the acting admin who still holds the current group key. Can't
  // un-share the past — rotation only limits what the removed admin can decrypt next.
  const rotateAfterAdminRemoval = async () => {
    if (!publicKey || !privateKey) return;
    const g = await ensureGroupKey().catch(() => null);
    if (!g) return;
    const sec = await myGroupPrivateKey(publicKey, privateKey).catch(() => null);
    if (!sec) return;
    await rotateGroup(g, sec).catch(() => {});
  };

  // Re-enabling an admin restores their name access: seal the current group key to
  // them (they lost it when disabling rotated the group). O(1), no rotation.
  const grantReenabledAdmin = async (userId: string) => {
    if (!publicKey || !privateKey) return;
    const admins = await Backend.Admin.listAdmins().catch(() => []);
    const a = admins.find((x) => x.userId === userId);
    if (a) await grantToAdmin(publicKey, privateKey, a.userId, a.publicKey).catch(() => {});
  };
  const [users, setUsers] = useState<ServerUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'user' | 'admin' | 'manager'>('user');
  // A manager can invite regular users only; only an admin assigns roles.
  const meIsAdmin = me?.role === 'admin';
  // Reset-access dialog: the admin sets a temp password to relay out-of-band; the user
  // re-keys on next login. Their sharing crypto is wiped server-side (re-request access).
  const [resetTarget, setResetTarget] = useState<ServerUser | null>(null);
  const [resetPw, setResetPw] = useState('');
  const [resetConfirm, setResetConfirm] = useState('');

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
      const created = await Backend.Admin.createUser(
        username.trim(),
        salt,
        DEFAULT_KDF_PARAMS,
        authHash,
        role,
        {
          masterSalt: vaultKey.masterSaltHex,
          protectedUserKey: vaultKey.protectedUserKey,
          publicKey: vaultKey.publicKeyHex,
          protectedPrivateKey: vaultKey.protectedPrivateKey,
        },
      );
      // A new admin needs the Admin-group key to read collection names — grant it now
      // (O(1); if no group exists yet they'll bootstrap + self-grant on first visit).
      if (role === 'admin' && publicKey && privateKey) {
        await grantToAdmin(publicKey, privateKey, created.id, vaultKey.publicKeyHex).catch(() => {});
      }
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

  const doReset = () => {
    const target = resetTarget;
    if (!target) return;
    act(async () => {
      const salt = randomSaltHex();
      const [authHash, vaultKey] = await Promise.all([
        deriveAuthHash(resetPw, salt, DEFAULT_KDF_PARAMS),
        createVaultKey(resetPw),
      ]);
      await Backend.Admin.resetUser(target.id, salt, DEFAULT_KDF_PARAMS, authHash, {
        masterSalt: vaultKey.masterSaltHex,
        protectedUserKey: vaultKey.protectedUserKey,
        publicKey: vaultKey.publicKeyHex,
        protectedPrivateKey: vaultKey.protectedPrivateKey,
      });
      // A reset admin loses group access → rotate so they can't decrypt names next.
      if (target.role === 'admin') await rotateAfterAdminRemoval();
      setResetTarget(null);
    });
  };

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5">
      <div className="flex items-center gap-3.5">
        <h1 className="text-[22px] font-bold">Users</h1>
        <span className="text-[13px] text-muted-foreground">Accounts on this instance</span>
      </div>

      {error && (
        <div className="rounded-md border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-600">
          {error}
        </div>
      )}

      <div className="overflow-x-auto rounded-2xl border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-semibold">Username</th>
              <th className="px-4 py-3 font-semibold">Role</th>
              <th className="px-4 py-3 font-semibold">Status</th>
              <th className="px-4 py-3 text-right font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const isSelf = u.id === me?.id;
              return (
                <tr key={u.id} className="border-t border-border">
                  <td className="px-4 py-2.5 font-medium">
                    {u.username}
                    {isSelf && <span className="ml-2 text-xs font-normal text-muted-foreground">(you)</span>}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
                        u.role === 'admin'
                          ? 'bg-primary/15 text-primary'
                          : u.role === 'manager'
                            ? 'bg-amber-500/15 text-amber-600'
                            : 'bg-secondary text-muted-foreground'
                      }`}
                    >
                      {u.role}
                    </span>
                    {/* Admins can promote/demote between user and manager (not admins). */}
                    {meIsAdmin && !isSelf && u.role !== 'admin' && (
                      <button
                        onClick={() =>
                          act(async () => {
                            await Backend.Admin.setRole(u.id, u.role === 'manager' ? 'user' : 'manager');
                          })
                        }
                        disabled={busy}
                        className="ml-2 rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                        title={u.role === 'manager' ? 'Demote to user' : 'Promote to manager'}
                      >
                        {u.role === 'manager' ? '→ user' : '→ manager'}
                      </button>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
                        u.status === 'active'
                          ? 'bg-green-500/15 text-green-500'
                          : 'bg-secondary text-muted-foreground'
                      }`}
                    >
                      {u.status}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {!isSelf && (
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() =>
                            act(async () => {
                              const next = u.status === 'active' ? 'disabled' : 'active';
                              await Backend.Admin.setStatus(u.id, next);
                              // Disabling an admin rotates the group (cuts their future
                              // name access — their group key is already client-side, so
                              // only rotation revokes it); re-enabling re-grants them.
                              if (u.role === 'admin') {
                                if (next === 'disabled') await rotateAfterAdminRemoval();
                                else await grantReenabledAdmin(u.id);
                              }
                            })
                          }
                          disabled={busy}
                          className="rounded border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
                        >
                          {u.status === 'active' ? 'Disable' : 'Enable'}
                        </button>
                        <button
                          onClick={() => {
                            setResetTarget(u);
                            setResetPw('');
                            setResetConfirm('');
                          }}
                          disabled={busy}
                          title="Reset access (lost password)"
                          className="rounded border border-amber-500/40 px-2 py-1 text-xs text-amber-600 hover:bg-amber-500/10 disabled:opacity-50"
                        >
                          Reset
                        </button>
                        <button
                          onClick={() =>
                            act(async () => {
                              await Backend.Admin.deleteUser(u.id);
                              // Removing an admin rotates the group so they lose future access.
                              if (u.role === 'admin') await rotateAfterAdminRemoval();
                            })
                          }
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
        className="space-y-3 rounded-2xl border border-border bg-card p-4"
      >
        <div className="text-sm font-semibold">Add a user</div>
        <div className="flex flex-wrap items-end gap-3">
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
          {meIsAdmin ? (
            <select
              id="new-role"
              value={role}
              onChange={(e) => setRole(e.target.value as 'user' | 'admin' | 'manager')}
              className="rounded-md border border-input bg-background px-3 py-2 text-sm"
              disabled={busy}
            >
              <option value="user">user</option>
              <option value="manager">manager</option>
              <option value="admin">admin</option>
            </select>
          ) : (
            // A manager can only invite regular users.
            <span className="rounded-md border border-input bg-muted px-3 py-2 text-sm text-muted-foreground">
              user
            </span>
          )}
        </div>
        <button
          type="submit"
          disabled={busy || !username.trim() || !password}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          Add user
        </button>
        </div>
      </form>

      {resetTarget && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={() => setResetTarget(null)}>
          <div className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold">Reset access for {resetTarget.username}?</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Use this when <b className="text-foreground">{resetTarget.username}</b> has lost their password. Verify
              it&apos;s really them first (in person, phone…). Set a temporary password to relay to them — they&apos;ll
              set their own at next login.
            </p>
            <div className="my-3 space-y-2 text-sm">
              <div className="rounded-md border border-green-500/30 bg-green-500/[0.08] p-2">
                <b>Kept:</b> their username, role, and every team they&apos;re in.
              </div>
              <div className="rounded-md border border-red-500/30 bg-red-500/[0.08] p-2">
                <b>Lost for good:</b> everything encrypted under the old password — personal connections and solo
                collections. They&apos;ll re-request access to shared collections.
              </div>
            </div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Temporary password</label>
            <input
              type="text"
              value={resetPw}
              onChange={(e) => setResetPw(e.target.value)}
              autoFocus
              placeholder="A temp password to relay to them"
              className="mb-2 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Confirm</label>
            <input
              type="text"
              value={resetConfirm}
              onChange={(e) => setResetConfirm(e.target.value)}
              placeholder="Type it again"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setResetTarget(null)} className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted">
                Cancel
              </button>
              <button
                onClick={doReset}
                disabled={busy || resetPw.length < 4 || resetPw !== resetConfirm}
                className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50"
              >
                Reset access
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
