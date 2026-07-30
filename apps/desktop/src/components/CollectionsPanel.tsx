/**
 * The user's collection manager (ADR 0016) — master-detail (design/mock/collections.html).
 * A flush left rail lists every collection you hold a key for (including empty ones the
 * machine-driven sidebar can't show); the right pane edits the selected one: colour,
 * rename, and — for shared collections you own — members/roles/sharing and delete.
 * Personal is special-cased (private, can't be shared or deleted). Names/colours are
 * decrypted client-side; machines themselves are managed in the workspace.
 */

import { useCallback, useEffect, useState } from 'react';
import { Backend, type UserCollection } from '../utils/backend';
import { useServerSession } from '../store/serverSessionStore';
import { unwrapCollectionKeys, decryptCollectionField } from '../utils/collectionCrypto';
import { readCollectionHeader, writeCollectionHeader, type CollectionHeader } from '../utils/collectionHeader';
import { MemberPicker } from './MemberPicker';
import { IconCollection } from './icons';

const COLLECTION_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#a855f7', '#14b8a6', '#f472b6'];
const DEFAULT_COLOR = '#94a3b8';

export function CollectionsPanel() {
  const { publicKey, privateKey } = useServerSession();
  const [collections, setCollections] = useState<UserCollection[]>([]);
  const [headers, setHeaders] = useState<Record<string, CollectionHeader>>({});
  const [memberCounts, setMemberCounts] = useState<Record<string, number>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [machineCount, setMachineCount] = useState<number | null>(null);
  const [renameVal, setRenameVal] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [showNew, setShowNew] = useState(false);
  const [manageMembers, setManageMembers] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const cols = await Backend.Collections.mine();
      const hdrs: Record<string, CollectionHeader> = {};
      for (const c of cols) {
        if (!c.protectedMetaKey || !publicKey || !privateKey) {
          hdrs[c.id] = { name: 'Collection', color: null };
          continue;
        }
        try {
          const { metaKey } = await unwrapCollectionKeys(publicKey, privateKey, c);
          hdrs[c.id] = await decryptCollectionField<CollectionHeader>(metaKey, c.nameEnc);
        } catch {
          hdrs[c.id] = { name: 'Collection', color: null };
        }
      }
      // Personal first, then by name.
      cols.sort((a, b) => {
        const pa = hdrs[a.id]?.personal ? 0 : 1;
        const pb = hdrs[b.id]?.personal ? 0 : 1;
        return pa - pb || (hdrs[a.id]?.name ?? '').localeCompare(hdrs[b.id]?.name ?? '');
      });
      const counts: Record<string, number> = {};
      await Promise.all(
        cols.map(async (c) => {
          counts[c.id] = (await Backend.Collections.members(c.id).catch(() => [])).length;
        }),
      );
      setCollections(cols);
      setHeaders(hdrs);
      setMemberCounts(counts);
      setSelectedId((prev) => (prev && cols.some((c) => c.id === prev) ? prev : (cols[0]?.id ?? null)));
    } catch {
      setError('Failed to load collections');
    }
  }, [publicKey, privateKey]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async initial load
    refresh();
  }, [refresh]);

  const selected = collections.find((c) => c.id === selectedId) ?? null;
  const header = selectedId ? headers[selectedId] : undefined;
  const isPersonal = !!header?.personal;
  const canWrite = selected?.role === 'owner' || selected?.role === 'editor';
  const canManage = selected?.role === 'owner' && !isPersonal;
  // Rename is an OWNER-only setting (the name is shared — every member reads it). Personal
  // collections are yours (you're the owner), so this covers them too. Editors write
  // machines/folders, not the collection's identity.
  const canRename = selected?.role === 'owner';

  // Keep the rename field + machine count in sync with the selection.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync UI to selection
    setRenameVal(header?.name ?? '');
    setMachineCount(null);
    if (!selectedId) return;
    Backend.Collections.items(selectedId)
      .then((its) => setMachineCount(its.length))
      .catch(() => setMachineCount(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react to selection only
  }, [selectedId]);

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

  const patchHeader = (id: string, patch: Partial<CollectionHeader>) =>
    run(async () => {
      if (!publicKey || !privateKey) throw new Error('session keys unavailable');
      const { metaKey, header: h } = await readCollectionHeader(id, publicKey, privateKey);
      await writeCollectionHeader(id, metaKey, { ...h, ...patch });
      await refresh();
    });

  const confirmDelete = () =>
    run(async () => {
      if (deleteTarget) await Backend.Collections.remove(deleteTarget.id);
      setDeleteTarget(null);
      await refresh();
    });

  return (
    <div className="flex min-h-0 flex-1">
      {/* Master — the collections rail */}
      <aside className="flex w-[280px] flex-none flex-col overflow-y-auto border-r border-border bg-input">
        <div className="flex items-center justify-between px-3.5 pb-2 pt-3">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            My collections
          </span>
          <button
            onClick={() => setShowNew(true)}
            className="flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" />
            </svg>
            New
          </button>
        </div>
        <ul className="space-y-0.5 px-2 pb-3">
          {collections.map((c) => {
            const h = headers[c.id];
            const on = c.id === selectedId;
            return (
              <li key={c.id}>
                <button
                  onClick={() => setSelectedId(c.id)}
                  className={`flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left text-sm transition ${
                    on ? 'border-primary/30 bg-primary/[0.13]' : 'border-transparent hover:bg-secondary'
                  }`}
                >
                  <IconCollection className="h-4 w-4 flex-none" color={h?.color ?? DEFAULT_COLOR} />
                  <span className={`min-w-0 flex-1 truncate ${on ? 'font-semibold text-primary' : 'font-medium'}`}>
                    {h?.name ?? '…'}
                  </span>
                  {h?.personal ? (
                    <span className="rounded bg-secondary px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-muted-foreground">
                      Personal
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-1.13a4 4 0 10-4-4 4 4 0 004 4z" />
                      </svg>
                      {memberCounts[c.id] ?? '·'}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      {/* Detail — the selected collection */}
      <main className="min-w-0 flex-1 overflow-y-auto px-8 py-7">
        <div className="mx-auto max-w-[820px]">
          {error && (
            <div className="mb-4 rounded-md border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-600">
              {error}
            </div>
          )}
          {!selected || !header ? (
            <p className="rounded-2xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
              No collections yet. Create one to share machines with your team.
            </p>
          ) : (
            <>
              <div className="mb-1 flex items-center gap-2.5">
                <IconCollection className="h-5 w-5 flex-none" color={header.color ?? DEFAULT_COLOR} />
                <h1 className="text-[22px] font-bold">{header.name}</h1>
                <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-bold uppercase text-muted-foreground">
                  {isPersonal ? 'Personal' : selected.role}
                </span>
                {machineCount !== null && (
                  <span className="text-[13px] text-muted-foreground">
                    · {machineCount} machine{machineCount === 1 ? '' : 's'}
                  </span>
                )}
              </div>
              <p className="mb-5 text-[13px] text-muted-foreground">
                {isPersonal
                  ? 'Your private space — only you. It can’t be shared or deleted; it always exists.'
                  : 'Machines live in the workspace — open this collection from the library sidebar to manage them.'}
              </p>

              {/* Colour (writers only) */}
              {canWrite && (
              <div className="mb-4 rounded-2xl border border-border bg-card p-4">
                <div className="mb-3 text-sm font-semibold">Colour</div>
                <div className="flex flex-wrap gap-2">
                  {COLLECTION_COLORS.map((c) => (
                    <button
                      key={c}
                      onClick={() => patchHeader(selected.id, { color: c })}
                      disabled={busy}
                      aria-label={`colour ${c}`}
                      className={`h-7 w-7 rounded-full disabled:opacity-50 ${
                        header.color === c ? 'ring-2 ring-foreground ring-offset-2 ring-offset-card' : ''
                      }`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
              </div>
              )}

              {/* Rename (owner only — settings action; the name is shared with all members) */}
              {canRename && (
              <div className="mb-4 flex flex-wrap items-end justify-between gap-3 rounded-2xl border border-border bg-card p-4">
                <div>
                  <div className="text-sm font-semibold">Rename</div>
                  <div className="text-xs text-muted-foreground">
                    {isPersonal ? 'Label your personal space.' : 'Shared — every member sees this name.'}
                  </div>

                </div>
                <div className="flex items-center gap-2">
                  <input
                    value={renameVal}
                    onChange={(e) => setRenameVal(e.target.value)}
                    className="w-56 rounded-md border border-input bg-background px-3 py-2 text-sm"
                    disabled={busy}
                  />
                  <button
                    onClick={() => patchHeader(selected.id, { name: renameVal.trim() })}
                    disabled={busy || !renameVal.trim() || renameVal.trim() === header.name}
                    className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    Save
                  </button>
                </div>
              </div>
              )}

              {/* Members / sharing (shared collections only) */}
              {!isPersonal && (
                <div className="mb-4 flex items-center justify-between rounded-2xl border border-border bg-card p-4">
                  <div>
                    <div className="text-sm font-semibold">Members &amp; sharing</div>
                    <div className="text-xs text-muted-foreground">
                      {memberCounts[selected.id] ?? '·'} member{memberCounts[selected.id] === 1 ? '' : 's'} ·{' '}
                      {canManage ? 'add or remove people and set roles' : 'you can view the roster'}
                    </div>
                  </div>
                  <button
                    onClick={() => setManageMembers(true)}
                    className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-secondary"
                  >
                    {canManage ? 'Manage members' : 'View members'}
                  </button>
                </div>
              )}

              {/* Delete (owner of a shared collection) */}
              {canManage && (
                <div className="flex items-center justify-between rounded-2xl border border-border bg-card px-4 py-3.5">
                  <div>
                    <div className="font-semibold text-red-500">Delete collection</div>
                    <div className="text-xs text-muted-foreground">
                      Removes it and its machines for every member. This can’t be undone.
                    </div>
                  </div>
                  <button
                    onClick={() => setDeleteTarget({ id: selected.id, name: header.name })}
                    className="rounded-md border border-red-500/40 px-3 py-1.5 text-sm font-medium text-red-500 hover:bg-red-500/10"
                  >
                    Delete
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </main>

      {showNew && (
        <MemberPicker
          mode="create"
          onClose={() => setShowNew(false)}
          onSaved={refresh}
          onCreated={(id) => setSelectedId(id)}
        />
      )}
      {manageMembers && selected && (
        <MemberPicker
          mode="edit"
          collectionId={selected.id}
          initialName={header?.name}
          onClose={() => setManageMembers(false)}
          onSaved={refresh}
        />
      )}
      {deleteTarget && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={() => setDeleteTarget(null)}>
          <div className="w-full max-w-sm rounded-lg border border-border bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-2 text-lg font-semibold">Delete “{deleteTarget.name}”?</h3>
            <p className="mb-4 text-sm text-muted-foreground">
              This permanently deletes the collection and its machines for everyone. Members lose access. This cannot be
              undone.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleteTarget(null)} className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted">
                Cancel
              </button>
              <button onClick={confirmDelete} disabled={busy} className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50">
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
