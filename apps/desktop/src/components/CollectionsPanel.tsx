/**
 * Collections directory (ADR 0016) — a lightweight surface, open to every org
 * member, that lists all the collections you hold a key for (including empty ones
 * the machine-driven sidebar can't show) and delegates the actual work: creating
 * and sharing go through the member picker, renaming through the small edit dialog,
 * and machines are managed in the workspace collection view. This panel keeps no
 * member/machine logic of its own — it just decrypts each collection's name/colour
 * for display and opens the right dialog.
 */

import { useCallback, useEffect, useState } from 'react';
import { Backend, type UserCollection } from '../utils/backend';
import { useServerSession } from '../store/serverSessionStore';
import { unwrapCollectionKey, decryptCollectionField } from '../utils/collectionCrypto';
import { MemberPicker } from './MemberPicker';
import { CollectionEditDialog } from './CollectionEditDialog';

interface Header {
  name: string;
  color: string | null;
}

export function CollectionsPanel() {
  const { publicKey, privateKey } = useServerSession();
  const [collections, setCollections] = useState<UserCollection[]>([]);
  const [headers, setHeaders] = useState<Record<string, Header>>({});
  const [error, setError] = useState<string | null>(null);

  const [showNew, setShowNew] = useState(false);
  const [shareId, setShareId] = useState<string | null>(null);
  const [rename, setRename] = useState<{ id: string; name: string; color: string | null } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const cols = await Backend.Collections.mine();
      setCollections(cols);
      const hdrs: Record<string, Header> = {};
      for (const c of cols) {
        if (!c.protectedCollectionKey || !publicKey || !privateKey) {
          hdrs[c.id] = { name: 'Collection', color: null };
          continue;
        }
        try {
          const key = await unwrapCollectionKey(publicKey, privateKey, c.protectedCollectionKey);
          hdrs[c.id] = await decryptCollectionField<Header>(key, c.nameEnc);
        } catch {
          hdrs[c.id] = { name: 'Collection', color: null };
        }
      }
      setHeaders(hdrs);
    } catch {
      setError('Failed to load collections');
    }
  }, [publicKey, privateKey]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async initial load
    refresh();
  }, [refresh]);

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await Backend.Collections.remove(deleteTarget.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete');
    } finally {
      setDeleteTarget(null);
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Collections</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Every collection you can access. Machines live in the workspace — open one from the library sidebar.
          </p>
        </div>
        <button
          onClick={() => setShowNew(true)}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" />
          </svg>
          New collection
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-600">{error}</div>
      )}

      {collections.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          No collections yet. Create one to share machines with your team.
        </p>
      ) : (
        <ul className="space-y-2">
          {collections.map((c) => {
            const h = headers[c.id];
            const canManage = c.role === 'owner';
            return (
              <li
                key={c.id}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-3"
              >
                <span
                  className="h-3 w-3 flex-none rounded-full"
                  style={{ backgroundColor: h?.color ?? '#94a3b8' }}
                />
                <span className="min-w-0 flex-1 truncate font-medium">{h?.name ?? '…'}</span>
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {c.role}
                </span>
                <button
                  onClick={() => setShareId(c.id)}
                  className="rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-muted"
                >
                  {canManage ? 'Members' : 'View members'}
                </button>
                {canManage && (
                  <button
                    onClick={() => setRename({ id: c.id, name: h?.name ?? '', color: h?.color ?? null })}
                    className="rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-muted"
                  >
                    Rename
                  </button>
                )}
                {canManage && (
                  <button
                    onClick={() => setDeleteTarget({ id: c.id, name: h?.name ?? 'this collection' })}
                    className="rounded-md border border-red-500/30 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-500/10"
                  >
                    Delete
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {showNew && <MemberPicker mode="create" onClose={() => setShowNew(false)} onSaved={refresh} />}
      {shareId && (
        <MemberPicker
          mode="edit"
          collectionId={shareId}
          initialName={headers[shareId]?.name}
          onClose={() => setShareId(null)}
          onSaved={refresh}
        />
      )}
      {rename && (
        <CollectionEditDialog
          collectionId={rename.id}
          initialName={rename.name}
          initialColor={rename.color}
          onClose={() => setRename(null)}
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
              <button onClick={confirmDelete} className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700">
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
