/**
 * Member picker (ADR 0016), transposed from design/mock — one dialog for both
 * creating a shared collection and managing an existing one's sharing.
 *
 * Layout mirrors the mock: (optional) name + colour, "add from team" chips that
 * snapshot a team, a searchable people list with avatars + inline role dropdowns,
 * and a role legend. All crypto is browser-side: the collection key is generated
 * (create) or unwrapped (edit) and sealed to each member; the ≥1-owner invariant
 * is enforced server-side. Create batches everything on confirm; edit applies each
 * change live (add seals + posts, remove/role hit the API immediately).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Backend,
  type CollectionRole,
  type DirectoryEntry,
  type UserTeam,
} from '../utils/backend';
import { useServerSession } from '../store/serverSessionStore';
import {
  generateCollectionKeys,
  sealCollectionKey,
  sealCollectionKeyToHex,
  unwrapCollectionKeys,
  encryptCollectionField,
} from '../utils/collectionCrypto';
import { escrowForCreate } from '../utils/adminGroup';

const ROLES: CollectionRole[] = ['owner', 'editor', 'viewer'];
const COLLECTION_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#a855f7', '#14b8a6', '#f472b6'];
const AVATAR_COLORS = ['#7c9cf5', '#9ece6a', '#e5b567', '#f0a35e', '#f7768e', '#bb9af7', '#56c7c0', '#e0af68'];

function avatarColor(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function Avatar({ name }: { name: string }) {
  return (
    <span
      className="grid h-6 w-6 flex-none place-items-center rounded-full text-[11px] font-bold text-black"
      style={{ backgroundColor: avatarColor(name) }}
      title={name}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function MemberPicker({
  mode,
  collectionId,
  initialName,
  initialColor,
  onClose,
  onSaved,
  onCreated,
}: {
  mode: 'create' | 'edit';
  collectionId?: string;
  initialName?: string;
  initialColor?: string | null;
  onClose: () => void;
  onSaved: () => void;
  onCreated?: (id: string) => void; // create mode: the new collection's id (for placement)
}) {
  const { user: me, publicKey, privateKey } = useServerSession();
  const isCreate = mode === 'create';

  const [name, setName] = useState(initialName ?? '');
  const [color, setColor] = useState(initialColor ?? COLLECTION_COLORS[0]);
  const [directory, setDirectory] = useState<DirectoryEntry[]>([]);
  const [teams, setTeams] = useState<UserTeam[]>([]);
  const [chosen, setChosen] = useState<Map<string, CollectionRole>>(new Map());
  const [collKeys, setCollKeys] = useState<{
    metaKey: Uint8Array;
    itemsKey: Uint8Array | null;
  } | null>(null);
  const [myRole, setMyRole] = useState<CollectionRole>('owner');
  // Members added roster-only by an admin (metaKey but no itemsKey) — a key-holding
  // owner can complete their machine access from here.
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const iManage = isCreate || myRole === 'owner';
  const owners = useMemo(() => [...chosen.values()].filter((r) => r === 'owner').length, [chosen]);

  const load = useCallback(async () => {
    try {
      const [dir, myTeams] = await Promise.all([
        Backend.Collections.directory().catch(() => [] as DirectoryEntry[]),
        Backend.Teams.mine().catch(() => [] as UserTeam[]),
      ]);
      setDirectory(dir);
      setTeams(myTeams);
      if (isCreate) {
        setChosen(new Map(me ? [[me.id, 'owner' as CollectionRole]] : []));
      } else if (collectionId) {
        const [mine, members] = await Promise.all([
          Backend.Collections.mine(),
          Backend.Collections.members(collectionId),
        ]);
        setChosen(new Map(members.map((m) => [m.userId, m.role])));
        setPending(new Set(members.filter((m) => m.hasItemsKey === false).map((m) => m.userId)));
        setMyRole(members.find((m) => m.userId === me?.id)?.role ?? 'viewer');
        const self = mine.find((c) => c.id === collectionId);
        if (self && publicKey && privateKey) {
          setCollKeys(await unwrapCollectionKeys(publicKey, privateKey, self));
        }
      }
    } catch {
      setError('Failed to load members');
    }
  }, [isCreate, collectionId, me, publicKey, privateKey]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async initial load
    load();
  }, [load]);

  const setLocal = (userId: string, role: CollectionRole | null) =>
    setChosen((prev) => {
      const next = new Map(prev);
      if (role) next.set(userId, role);
      else next.delete(userId);
      return next;
    });

  const run = async (fn: () => Promise<unknown>) => {
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

  // Toggle a member. Create batches locally; edit applies live (seal + API).
  const toggle = (entry: DirectoryEntry) => {
    if (!iManage || entry.id === me?.id) return;
    const has = chosen.has(entry.id);
    if (isCreate) {
      setLocal(entry.id, has ? null : 'viewer');
      return;
    }
    if (!collKeys || !collectionId) return;
    const { metaKey, itemsKey } = collKeys;
    void run(async () => {
      if (has) {
        await Backend.Collections.removeMember(collectionId, entry.id);
        setLocal(entry.id, null);
      } else {
        if (!entry.publicKey) throw new Error('that user has no published key yet');
        if (!itemsKey) throw new Error('you do not hold this collection’s machine key');
        await Backend.Collections.addMember(
          collectionId,
          entry.id,
          'viewer',
          await sealCollectionKeyToHex(entry.publicKey, metaKey),
          await sealCollectionKeyToHex(entry.publicKey, itemsKey),
        );
        setLocal(entry.id, 'viewer');
      }
      onSaved();
    });
  };

  const changeRole = (userId: string, role: CollectionRole) => {
    if (isCreate) {
      setLocal(userId, role);
      return;
    }
    if (!collectionId) return;
    void run(async () => {
      await Backend.Collections.setRole(collectionId, userId, role);
      setLocal(userId, role);
      onSaved();
    });
  };

  // Complete a roster-only member's access: seal both keys to them (an owner holds
  // the itemsKey the admin meta-add couldn't). Upserts → sets their itemsKey.
  const grantMachineAccess = (entry: DirectoryEntry) => {
    if (!collKeys?.itemsKey || !collectionId || !entry.publicKey) return;
    const { metaKey, itemsKey } = collKeys;
    const role = chosen.get(entry.id) ?? 'viewer';
    void run(async () => {
      await Backend.Collections.addMember(
        collectionId,
        entry.id,
        role,
        await sealCollectionKeyToHex(entry.publicKey!, metaKey),
        await sealCollectionKeyToHex(entry.publicKey!, itemsKey),
      );
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(entry.id);
        return next;
      });
      onSaved();
    });
  };

  const addFromTeam = (teamId: string) =>
    run(async () => {
      const members = await Backend.Teams.members(teamId);
      for (const tm of members) {
        if (chosen.has(tm.userId)) continue;
        if (isCreate) {
          setLocal(tm.userId, 'viewer');
          continue;
        }
        if (!collKeys?.itemsKey || !collectionId) continue;
        const pub = tm.publicKey ?? directory.find((d) => d.id === tm.userId)?.publicKey;
        if (!pub) continue;
        await Backend.Collections.addMember(
          collectionId,
          tm.userId,
          'viewer',
          await sealCollectionKeyToHex(pub, collKeys.metaKey),
          await sealCollectionKeyToHex(pub, collKeys.itemsKey),
        );
        setLocal(tm.userId, 'viewer');
      }
      if (!isCreate) onSaved();
    });

  const confirmCreate = () =>
    run(async () => {
      if (!name.trim() || !publicKey) throw new Error('a name is required');
      const { metaKey, itemsKey } = generateCollectionKeys();
      const nameEnc = await encryptCollectionField(metaKey, { name: name.trim(), color });
      const { id } = await Backend.Collections.create(
        nameEnc,
        await sealCollectionKey(publicKey, metaKey),
        await sealCollectionKey(publicKey, itemsKey),
        await escrowForCreate(metaKey),
      );
      for (const [userId, role] of chosen) {
        if (userId === me?.id) continue;
        const pub = directory.find((d) => d.id === userId)?.publicKey;
        if (!pub) continue;
        await Backend.Collections.addMember(
          id,
          userId,
          role,
          await sealCollectionKeyToHex(pub, metaKey),
          await sealCollectionKeyToHex(pub, itemsKey),
        );
      }
      onCreated?.(id);
      onSaved();
      onClose();
    });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return directory.filter((d) => !q || d.username.toLowerCase().includes(q));
  }, [directory, search]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-lg border border-border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-lg font-semibold">{isCreate ? 'New collection' : `Share · ${initialName ?? ''}`}</h3>
          <button onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-muted" aria-label="Close">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          {chosen.size} member{chosen.size > 1 ? 's' : ''} · {owners} owner{owners > 1 ? 's' : ''}
        </p>

        {error && (
          <div className="mb-3 rounded-md border border-red-500/20 bg-red-500/10 p-2 text-sm text-red-600">{error}</div>
        )}

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
          {isCreate && (
            <>
              <div>
                <label className="mb-1 block text-sm font-medium">Name</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                  placeholder="e.g. Production DBs"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  disabled={busy}
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">Colour</label>
                <div className="flex flex-wrap gap-2">
                  {COLLECTION_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setColor(c)}
                      className={`h-7 w-7 rounded-full ${color === c ? 'ring-2 ring-foreground ring-offset-2 ring-offset-card' : ''}`}
                      style={{ backgroundColor: c }}
                      aria-label={`colour ${c}`}
                    />
                  ))}
                </div>
              </div>
            </>
          )}

          {iManage && teams.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">Add from team:</span>
              {teams.map((tm) => (
                <button
                  key={tm.id}
                  onClick={() => addFromTeam(tm.id)}
                  disabled={busy}
                  className="flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-50"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-1.13a4 4 0 10-4-4 4 4 0 004 4z" />
                  </svg>
                  {tm.name}
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5">
            <svg className="h-4 w-4 flex-none text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M11 18a7 7 0 100-14 7 7 0 000 14z" />
            </svg>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search people…"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            />
          </div>

          <ul className="space-y-1">
            {filtered.map((d) => {
              const role = chosen.get(d.id);
              const on = role !== undefined;
              const isMe = d.id === me?.id;
              const lockOwner = role === 'owner' && owners < 2;
              return (
                <li key={d.id}>
                  <div
                    className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 ${
                      iManage && !isMe ? 'cursor-pointer hover:bg-muted' : ''
                    }`}
                    onClick={() => toggle(d)}
                  >
                    <span
                      className={`grid h-[17px] w-[17px] flex-none place-items-center rounded border ${
                        on ? 'border-primary bg-primary text-[11px] text-primary-foreground' : 'border-border'
                      }`}
                    >
                      {on ? '✓' : ''}
                    </span>
                    <Avatar name={d.username} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">
                        {d.username}
                        {role === 'owner' && <span title="owner"> 👑</span>}
                        {isMe && <span className="text-xs text-muted-foreground"> · you</span>}
                      </div>
                    </div>
                    {on &&
                      pending.has(d.id) &&
                      (iManage && collKeys?.itemsKey && !isMe ? (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            grantMachineAccess(d);
                          }}
                          disabled={busy}
                          title="Roster-only: sees the name but no machines. Seal machine access to them."
                          className="rounded border border-primary/40 px-2 py-0.5 text-[10px] font-medium text-primary hover:bg-primary/10 disabled:opacity-50"
                        >
                          Grant machine access
                        </button>
                      ) : (
                        <span
                          title="Awaiting machine access from a member"
                          className="rounded-full bg-secondary px-2 py-0.5 text-[10px] uppercase text-muted-foreground"
                        >
                          no machines
                        </span>
                      ))}
                    {on &&
                      (iManage && !isMe ? (
                        <select
                          value={role}
                          disabled={busy || lockOwner}
                          title={lockOwner ? 'the collection needs at least one owner' : undefined}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => changeRole(d.id, e.target.value as CollectionRole)}
                          className="rounded border border-input bg-background px-2 py-1 text-xs"
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-xs uppercase text-muted-foreground">{role}</span>
                      ))}
                  </div>
                </li>
              );
            })}
            {filtered.length === 0 && <li className="px-2 py-3 text-center text-sm text-muted-foreground">No one found.</li>}
          </ul>

          <p className="text-xs text-muted-foreground">
            Members hold the collection key. <b className="text-foreground">Owner</b> manages sharing &amp; settings ·{' '}
            <b className="text-foreground">Editor</b> adds/edits machines (re-encrypts) ·{' '}
            <b className="text-foreground">Viewer</b> can only connect.
          </p>
        </div>

        <div className="mt-4 flex justify-end gap-2 border-t border-border pt-3">
          <button onClick={onClose} className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted">
            {isCreate ? 'Cancel' : 'Done'}
          </button>
          {isCreate && (
            <button
              onClick={confirmCreate}
              disabled={busy || !name.trim()}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              Create
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
