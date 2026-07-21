/**
 * Collections management (ADR 0016): the unified sharing surface, open to every
 * org member (not just admins). A collection carries a symmetric key sealed to
 * each member (ADR 0013 sealbox); the browser does all crypto and the server only
 * stores opaque blobs — encrypted name/colour, sealed keys, encrypted items.
 *
 * - Create: generate the collection key, seal it to myself (I become the first
 *   owner), encrypt the {name, colour} header.
 * - Members: search the org directory or snapshot a team ("add from team"), seal
 *   the key to each and assign a role (owner/editor/viewer). ≥1 owner is enforced
 *   server-side (a last-owner demotion/removal 409s).
 * - Machines: a collection's items, encrypted with its key; editors and owners
 *   may add/remove, viewers are read-only.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Backend,
  type UserCollection,
  type CollectionMember,
  type CollectionRole,
  type DirectoryEntry,
  type UserTeam,
} from '../utils/backend';
import { useServerSession } from '../store/serverSessionStore';
import type { StoredRecord } from '../store/accountsConnectionsSource';
import {
  generateCollectionKey,
  sealCollectionKey,
  sealCollectionKeyToHex,
  unwrapCollectionKey,
  encryptCollectionField,
  decryptCollectionField,
} from '../utils/collectionCrypto';

interface Header {
  name: string;
  color: string | null;
}

/** A decrypted machine within the selected collection. */
interface Machine {
  id: string;
  record: StoredRecord;
}

const ROLES: CollectionRole[] = ['owner', 'editor', 'viewer'];

/** A small, fixed palette for the collection dot (client-side, no server leak). */
const COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#a855f7'];

function canWrite(role: CollectionRole): boolean {
  return role === 'owner' || role === 'editor';
}

export function CollectionsPanel() {
  const { user: me, publicKey, privateKey } = useServerSession();
  const [collections, setCollections] = useState<UserCollection[]>([]);
  const [headers, setHeaders] = useState<Record<string, Header>>({});
  const [selected, setSelected] = useState<UserCollection | null>(null);
  const [members, setMembers] = useState<CollectionMember[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [directory, setDirectory] = useState<DirectoryEntry[]>([]);
  const [teams, setTeams] = useState<UserTeam[]>([]);

  // Form state.
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(COLORS[0]);
  const [addUserId, setAddUserId] = useState('');
  const [addRole, setAddRole] = useState<CollectionRole>('viewer');
  const [teamId, setTeamId] = useState('');
  const [machineForm, setMachineForm] = useState({ name: '', hostname: '', username: '', port: 22, password: '' });

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canUnwrap = !!publicKey && !!privateKey;

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

  /** Unwrap my sealed key for a collection (needed to seal to others / de-en items). */
  const keyFor = useCallback(
    async (col: UserCollection): Promise<Uint8Array> => {
      if (!publicKey || !privateKey || !col.protectedCollectionKey) {
        throw new Error('you do not hold this collection key');
      }
      return unwrapCollectionKey(publicKey, privateKey, col.protectedCollectionKey);
    },
    [publicKey, privateKey],
  );

  const refresh = useCallback(async () => {
    try {
      const [cols, dir, myTeams] = await Promise.all([
        Backend.Collections.mine(),
        Backend.Collections.directory().catch(() => [] as DirectoryEntry[]),
        Backend.Teams.mine().catch(() => [] as UserTeam[]),
      ]);
      setCollections(cols);
      setDirectory(dir);
      setTeams(myTeams);
      // Decrypt each collection's header for display.
      const hdrs: Record<string, Header> = {};
      for (const c of cols) {
        if (!c.protectedCollectionKey || !canUnwrap) continue;
        try {
          const key = await keyFor(c);
          hdrs[c.id] = await decryptCollectionField<Header>(key, c.nameEnc);
        } catch {
          hdrs[c.id] = { name: 'Collection', color: null };
        }
      }
      setHeaders(hdrs);
    } catch {
      setError('Failed to load collections');
    }
  }, [canUnwrap, keyFor]);

  const openCollection = useCallback(
    async (col: UserCollection) => {
      setSelected(col);
      setMembers([]);
      setMachines([]);
      try {
        setMembers(await Backend.Collections.members(col.id));
        if (col.protectedCollectionKey && canUnwrap) {
          const key = await keyFor(col);
          const items = await Backend.Collections.items(col.id);
          const decoded: Machine[] = [];
          for (const it of items) {
            try {
              decoded.push({ id: it.id, record: await decryptCollectionField<StoredRecord>(key, it.blob) });
            } catch {
              // Undecryptable item — skip.
            }
          }
          setMachines(decoded);
        }
      } catch {
        setError('Failed to open collection');
      }
    },
    [canUnwrap, keyFor],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async initial load
    refresh();
  }, [refresh]);

  const myRole: CollectionRole | null = selected
    ? (members.find((m) => m.userId === me?.id)?.role ?? selected.role)
    : null;
  const iManage = myRole === 'owner';
  const iWrite = myRole !== null && canWrite(myRole);

  const createCollection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !publicKey) return;
    await act(async () => {
      const key = generateCollectionKey();
      const nameEnc = await encryptCollectionField(key, { name: newName.trim(), color: newColor });
      const protectedCollectionKey = await sealCollectionKey(publicKey, key);
      await Backend.Collections.create(nameEnc, protectedCollectionKey);
      setNewName('');
      await refresh();
    });
  };

  const addMember = async (userId: string, role: CollectionRole) => {
    if (!selected) return;
    const entry = directory.find((d) => d.id === userId);
    if (!entry?.publicKey) {
      setError('that user has no published key yet');
      return;
    }
    await act(async () => {
      const key = await keyFor(selected);
      const sealed = await sealCollectionKeyToHex(entry.publicKey!, key);
      await Backend.Collections.addMember(selected.id, userId, role, sealed);
      await openCollection(selected);
    });
  };

  const addFromTeam = async () => {
    if (!selected || !teamId) return;
    await act(async () => {
      const key = await keyFor(selected);
      const teamMembers = await Backend.Teams.members(teamId);
      for (const tm of teamMembers) {
        if (members.some((m) => m.userId === tm.userId)) continue; // already a member
        const dirEntry = directory.find((d) => d.id === tm.userId);
        const pub = tm.publicKey ?? dirEntry?.publicKey;
        if (!pub) continue; // no key to seal to — skip (documented)
        const sealed = await sealCollectionKeyToHex(pub, key);
        await Backend.Collections.addMember(selected.id, tm.userId, 'viewer', sealed);
      }
      setTeamId('');
      await openCollection(selected);
    });
  };

  const addMachine = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected || !machineForm.hostname.trim()) return;
    await act(async () => {
      const key = await keyFor(selected);
      const record: StoredRecord = {
        name: machineForm.name.trim() || machineForm.hostname.trim(),
        protocol: 'ssh',
        hostname: machineForm.hostname.trim(),
        port: machineForm.port || 22,
        username: machineForm.username.trim(),
        authMethod: { type: 'password', password: machineForm.password },
        color: null,
        icon: null,
        folder: null,
        notes: null,
        sshKeepAliveOverride: null,
        sshKeepAliveInterval: null,
      };
      const blob = await encryptCollectionField(key, record);
      await Backend.Collections.createItem(selected.id, blob);
      setMachineForm({ name: '', hostname: '', username: '', port: 22, password: '' });
      await openCollection(selected);
    });
  };

  const nonMembers = useMemo(
    () => directory.filter((d) => d.id !== me?.id && !members.some((m) => m.userId === d.id)),
    [directory, members, me?.id],
  );

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Collections</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Share a set of machines with chosen people — each holds a sealed copy of the collection key.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-600">{error}</div>
      )}

      <div className="flex flex-wrap gap-2">
        {collections.map((c) => (
          <button
            key={c.id}
            onClick={() => openCollection(c)}
            className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm ${
              selected?.id === c.id ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted'
            }`}
          >
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: headers[c.id]?.color ?? '#94a3b8' }}
            />
            {headers[c.id]?.name ?? '…'}
            <span className="text-xs uppercase text-muted-foreground">{c.role}</span>
          </button>
        ))}
        {collections.length === 0 && <p className="text-sm text-muted-foreground">No collections yet.</p>}
      </div>

      <form onSubmit={createCollection} className="flex items-end gap-3 rounded-lg border border-border bg-card p-4">
        <div className="flex-1 space-y-1">
          <label htmlFor="new-col" className="text-xs font-medium text-muted-foreground">
            New collection name
          </label>
          <input
            id="new-col"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            disabled={busy}
          />
        </div>
        <div className="flex gap-1.5 pb-2">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setNewColor(c)}
              className={`h-6 w-6 rounded-full ${newColor === c ? 'ring-2 ring-offset-2 ring-offset-card' : ''}`}
              style={{ backgroundColor: c, ...(newColor === c ? { boxShadow: `0 0 0 2px ${c}` } : {}) }}
              aria-label={`colour ${c}`}
            />
          ))}
        </div>
        <button
          type="submit"
          disabled={busy || !newName.trim()}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          Create
        </button>
      </form>

      {selected && (
        <div className="space-y-5 rounded-lg border border-border p-4">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-2 font-medium">
              <span
                className="h-3 w-3 rounded-full"
                style={{ backgroundColor: headers[selected.id]?.color ?? '#94a3b8' }}
              />
              {headers[selected.id]?.name ?? 'Collection'}
              <span className="text-xs uppercase text-muted-foreground">({myRole})</span>
            </h3>
            {iManage && (
              <button
                onClick={() =>
                  act(async () => {
                    await Backend.Collections.remove(selected.id);
                    setSelected(null);
                    await refresh();
                  })
                }
                disabled={busy}
                className="rounded border border-red-500/30 px-2 py-1 text-xs text-red-600 hover:bg-red-500/10 disabled:opacity-50"
              >
                Delete collection
              </button>
            )}
          </div>

          {/* Members */}
          <div className="space-y-3">
            <h4 className="text-sm font-medium text-muted-foreground">Members</h4>
            <table className="w-full text-sm">
              <tbody>
                {members.map((m) => (
                  <tr key={m.userId} className="border-t border-border">
                    <td className="py-1.5">{m.username}</td>
                    <td className="py-1.5">
                      {iManage && m.userId !== me?.id ? (
                        <select
                          value={m.role}
                          onChange={(e) =>
                            act(async () => {
                              await Backend.Collections.setRole(selected.id, m.userId, e.target.value as CollectionRole);
                              await openCollection(selected);
                            })
                          }
                          disabled={busy}
                          className="rounded border border-input bg-background px-2 py-1 text-xs"
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-xs uppercase text-muted-foreground">{m.role}</span>
                      )}
                    </td>
                    <td className="py-1.5 text-right">
                      {iManage && m.userId !== me?.id && (
                        <button
                          onClick={() =>
                            act(async () => {
                              await Backend.Collections.removeMember(selected.id, m.userId);
                              await openCollection(selected);
                            })
                          }
                          disabled={busy}
                          className="rounded border border-red-500/30 px-2 py-0.5 text-xs text-red-600 hover:bg-red-500/10 disabled:opacity-50"
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {iManage && (
              <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
                <div className="flex items-end gap-2">
                  <div className="flex-1 space-y-1">
                    <label htmlFor="add-col-member" className="text-xs font-medium text-muted-foreground">
                      Add from directory
                    </label>
                    <select
                      id="add-col-member"
                      value={addUserId}
                      onChange={(e) => setAddUserId(e.target.value)}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      disabled={busy || nonMembers.length === 0}
                    >
                      <option value="">Select a person…</option>
                      {nonMembers.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.username}
                        </option>
                      ))}
                    </select>
                  </div>
                  <select
                    value={addRole}
                    onChange={(e) => setAddRole(e.target.value as CollectionRole)}
                    className="rounded-md border border-input bg-background px-3 py-2 text-sm"
                    disabled={busy}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => addUserId && addMember(addUserId, addRole).then(() => setAddUserId(''))}
                    disabled={busy || !addUserId}
                    className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    Add
                  </button>
                </div>

                {teams.length > 0 && (
                  <div className="flex items-end gap-2">
                    <div className="flex-1 space-y-1">
                      <label htmlFor="add-from-team" className="text-xs font-medium text-muted-foreground">
                        Add from team (snapshot, as viewers)
                      </label>
                      <select
                        id="add-from-team"
                        value={teamId}
                        onChange={(e) => setTeamId(e.target.value)}
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        disabled={busy}
                      >
                        <option value="">Select a team…</option>
                        {teams.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <button
                      onClick={addFromTeam}
                      disabled={busy || !teamId}
                      className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
                    >
                      Snapshot
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Machines */}
          <div className="space-y-3">
            <h4 className="text-sm font-medium text-muted-foreground">Machines</h4>
            {machines.length === 0 && <p className="text-sm text-muted-foreground">No machines yet.</p>}
            <ul className="space-y-1">
              {machines.map((m) => (
                <li key={m.id} className="flex items-center justify-between rounded border border-border px-3 py-1.5 text-sm">
                  <span>
                    {m.record.name}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {m.record.username}@{m.record.hostname}:{m.record.port}
                    </span>
                  </span>
                  {iWrite && (
                    <button
                      onClick={() =>
                        act(async () => {
                          await Backend.Collections.deleteItem(selected.id, m.id);
                          await openCollection(selected);
                        })
                      }
                      disabled={busy}
                      className="rounded border border-red-500/30 px-2 py-0.5 text-xs text-red-600 hover:bg-red-500/10 disabled:opacity-50"
                    >
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>

            {iWrite && (
              <form onSubmit={addMachine} className="grid grid-cols-2 gap-2 rounded-md border border-border bg-muted/30 p-3 sm:grid-cols-5">
                <input
                  value={machineForm.name}
                  onChange={(e) => setMachineForm({ ...machineForm, name: e.target.value })}
                  placeholder="Name"
                  className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                  disabled={busy}
                />
                <input
                  value={machineForm.hostname}
                  onChange={(e) => setMachineForm({ ...machineForm, hostname: e.target.value })}
                  placeholder="Hostname"
                  className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                  disabled={busy}
                />
                <input
                  value={machineForm.username}
                  onChange={(e) => setMachineForm({ ...machineForm, username: e.target.value })}
                  placeholder="User"
                  className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                  disabled={busy}
                />
                <input
                  type="password"
                  value={machineForm.password}
                  onChange={(e) => setMachineForm({ ...machineForm, password: e.target.value })}
                  placeholder="Password"
                  className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                  disabled={busy}
                />
                <button
                  type="submit"
                  disabled={busy || !machineForm.hostname.trim()}
                  className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  Add machine
                </button>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
