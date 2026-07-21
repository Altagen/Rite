/**
 * Collection member picker (ADR 0016) — a reusable modal for one collection's
 * sharing: the member list + roles, add-from-directory and add-from-team snapshot.
 *
 * Self-contained: it fetches the collection's sealed key (from `mine()`), unwraps
 * it, and seals it to each added member. All crypto is browser-side; the server
 * only stores sealed keys and role rows. Owners manage; non-owners see it read-only.
 * The ≥1-owner invariant is enforced server-side (a last-owner change 409s).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Backend,
  type CollectionMember,
  type CollectionRole,
  type DirectoryEntry,
  type UserTeam,
} from '../utils/backend';
import { useServerSession } from '../store/serverSessionStore';
import { sealCollectionKeyToHex, unwrapCollectionKey } from '../utils/collectionCrypto';

const ROLES: CollectionRole[] = ['owner', 'editor', 'viewer'];

export function CollectionShareDialog({
  collectionId,
  title,
  onClose,
  onChanged,
}: {
  collectionId: string;
  title?: string;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const { user: me, publicKey, privateKey } = useServerSession();
  const [protectedKey, setProtectedKey] = useState<string | null>(null);
  const [myRole, setMyRole] = useState<CollectionRole>('viewer');
  const [members, setMembers] = useState<CollectionMember[]>([]);
  const [directory, setDirectory] = useState<DirectoryEntry[]>([]);
  const [teams, setTeams] = useState<UserTeam[]>([]);
  const [addUserId, setAddUserId] = useState('');
  const [addRole, setAddRole] = useState<CollectionRole>('viewer');
  const [teamId, setTeamId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const iManage = myRole === 'owner';

  const key = useCallback(async (): Promise<Uint8Array> => {
    if (!publicKey || !privateKey || !protectedKey) throw new Error('you do not hold this collection key');
    return unwrapCollectionKey(publicKey, privateKey, protectedKey);
  }, [publicKey, privateKey, protectedKey]);

  const load = useCallback(async () => {
    try {
      const [mine, mem, dir, myTeams] = await Promise.all([
        Backend.Collections.mine(),
        Backend.Collections.members(collectionId),
        Backend.Collections.directory().catch(() => [] as DirectoryEntry[]),
        Backend.Teams.mine().catch(() => [] as UserTeam[]),
      ]);
      const self = mine.find((c) => c.id === collectionId);
      setProtectedKey(self?.protectedCollectionKey ?? null);
      setMyRole(mem.find((m) => m.userId === me?.id)?.role ?? self?.role ?? 'viewer');
      setMembers(mem);
      setDirectory(dir);
      setTeams(myTeams);
    } catch {
      setError('Failed to load members');
    }
  }, [collectionId, me?.id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async initial load
    load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  const addMember = (userId: string, role: CollectionRole) => {
    const entry = directory.find((d) => d.id === userId);
    if (!entry?.publicKey) {
      setError('that user has no published key yet');
      return;
    }
    void act(async () => {
      const sealed = await sealCollectionKeyToHex(entry.publicKey!, await key());
      await Backend.Collections.addMember(collectionId, userId, role, sealed);
      setAddUserId('');
    });
  };

  const addFromTeam = () =>
    teamId &&
    act(async () => {
      const k = await key();
      const teamMembers = await Backend.Teams.members(teamId);
      for (const tm of teamMembers) {
        if (members.some((m) => m.userId === tm.userId)) continue;
        const pub = tm.publicKey ?? directory.find((d) => d.id === tm.userId)?.publicKey;
        if (!pub) continue;
        await Backend.Collections.addMember(collectionId, tm.userId, 'viewer', await sealCollectionKeyToHex(pub, k));
      }
      setTeamId('');
    });

  const nonMembers = useMemo(
    () => directory.filter((d) => d.id !== me?.id && !members.some((m) => m.userId === d.id)),
    [directory, members, me?.id],
  );

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-lg border border-border bg-card p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-lg font-semibold">{title ?? 'Members & sharing'}</h3>
          <button onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-muted" aria-label="Close">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {error && (
          <div className="mb-3 rounded-md border border-red-500/20 bg-red-500/10 p-2 text-sm text-red-600">{error}</div>
        )}

        <table className="w-full text-sm">
          <tbody>
            {members.map((m) => (
              <tr key={m.userId} className="border-t border-border">
                <td className="py-1.5">
                  {m.username}
                  {m.userId === me?.id && <span className="ml-1 text-xs text-muted-foreground">· you</span>}
                </td>
                <td className="py-1.5">
                  {iManage && m.userId !== me?.id ? (
                    <select
                      value={m.role}
                      onChange={(e) =>
                        act(() => Backend.Collections.setRole(collectionId, m.userId, e.target.value as CollectionRole))
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
                      onClick={() => act(() => Backend.Collections.removeMember(collectionId, m.userId))}
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

        {iManage ? (
          <div className="mt-4 space-y-2 rounded-md border border-border bg-muted/30 p-3">
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-1">
                <label htmlFor="share-add" className="text-xs font-medium text-muted-foreground">
                  Add from directory
                </label>
                <select
                  id="share-add"
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
                onClick={() => addUserId && addMember(addUserId, addRole)}
                disabled={busy || !addUserId}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                Add
              </button>
            </div>

            {teams.length > 0 && (
              <div className="flex items-end gap-2">
                <div className="flex-1 space-y-1">
                  <label htmlFor="share-team" className="text-xs font-medium text-muted-foreground">
                    Add from team (snapshot, as viewers)
                  </label>
                  <select
                    id="share-team"
                    value={teamId}
                    onChange={(e) => setTeamId(e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    disabled={busy}
                  >
                    <option value="">Select a team…</option>
                    {teams.map((tm) => (
                      <option key={tm.id} value={tm.id}>
                        {tm.name}
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
            <p className="text-xs text-muted-foreground">
              Owner manages sharing · Editor adds/edits machines · Viewer can only connect. At least one owner is
              required.
            </p>
          </div>
        ) : (
          <p className="mt-4 text-xs text-muted-foreground">Only an owner can change sharing.</p>
        )}
      </div>
    </div>
  );
}
