/**
 * Access-requests inbox (ADR 0016) — a bell in the collections header that shows pending
 * requests I can grant (I own/edit the collection). Granting seals the collection's keys to
 * the requester (a re-seal, exactly like the member picker) and clears the request; dismissing
 * just clears it. The server only ever saw who-asked-for-which — never a key.
 */

import { useCallback, useEffect, useState } from 'react';
import { Backend, type IncomingRequest, type UserCollection } from '../utils/backend';
import { useServerSession } from '../store/serverSessionStore';
import { unwrapCollectionKeys, sealCollectionKeyToHex } from '../utils/collectionCrypto';

export function AccessRequestsBell() {
  const { publicKey, privateKey } = useServerSession();
  const [open, setOpen] = useState(false);
  const [requests, setRequests] = useState<IncomingRequest[]>([]);
  const [mine, setMine] = useState<UserCollection[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [reqs, cols] = await Promise.all([
        Backend.Collections.incomingRequests().catch(() => [] as IncomingRequest[]),
        Backend.Collections.mine().catch(() => [] as UserCollection[]),
      ]);
      setRequests(reqs);
      setMine(cols);
    } catch {
      /* leave as-is */
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async initial load + poll
    refresh();
    const t = setInterval(refresh, 60_000);
    return () => clearInterval(t);
  }, [refresh]);

  const key = (r: IncomingRequest) => `${r.collectionId}:${r.userId}`;

  const run = (r: IncomingRequest, fn: () => Promise<unknown>) => {
    setBusy(key(r));
    setError(null);
    void (async () => {
      try {
        await fn();
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Action failed');
      } finally {
        setBusy(null);
      }
    })();
  };

  // Grant = seal metaKey + itemsKey to the requester (I hold them as owner/editor), add them
  // as a viewer, then clear the request.
  const grant = (r: IncomingRequest) =>
    run(r, async () => {
      if (!publicKey || !privateKey) throw new Error('session keys unavailable');
      if (!r.publicKey) throw new Error('that user has no published key yet');
      const col = mine.find((c) => c.id === r.collectionId);
      if (!col) throw new Error('you no longer hold this collection');
      const { metaKey, itemsKey } = await unwrapCollectionKeys(publicKey, privateKey, col);
      if (!itemsKey) throw new Error('you do not hold this collection’s machine key');
      await Backend.Collections.addMember(
        r.collectionId,
        r.userId,
        'viewer',
        await sealCollectionKeyToHex(r.publicKey, metaKey),
        await sealCollectionKeyToHex(r.publicKey, itemsKey),
      );
      await Backend.Collections.resolveRequest(r.collectionId, r.userId);
    });

  const dismiss = (r: IncomingRequest) =>
    run(r, () => Backend.Collections.resolveRequest(r.collectionId, r.userId));

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="m-btn m-btn-ghost m-btn-sm relative"
        title="Access requests"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0" />
        </svg>
        {requests.length > 0 && (
          <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-amber-500 ring-2 ring-background" />
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-[calc(100%+6px)] z-50 w-[min(92vw,440px)] rounded-xl border border-border bg-card shadow-xl">
            <div className="border-b border-border px-4 py-3">
              <div className="text-sm font-semibold">Notifications</div>
              <div className="text-xs text-muted-foreground">People asking to join collections you can grant.</div>
            </div>
            {error && <div className="px-4 pt-3 text-sm text-red-600">{error}</div>}
            <div className="max-h-[60vh] overflow-y-auto p-2">
              {requests.length === 0 ? (
                <div className="py-6 text-center text-sm text-muted-foreground">
                  No pending requests — you&apos;re all caught up.
                </div>
              ) : (
                requests.map((r) => (
                  <div key={key(r)} className="flex items-center gap-2.5 rounded-md px-2 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">
                        <b>{r.username}</b> requests access
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {r.teamName ? `discovered via team ${r.teamName}` : 'access request'}
                      </div>
                    </div>
                    <button
                      onClick={() => dismiss(r)}
                      disabled={busy === key(r)}
                      className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
                    >
                      Dismiss
                    </button>
                    <button
                      onClick={() => grant(r)}
                      disabled={busy === key(r)}
                      className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                    >
                      Grant
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
