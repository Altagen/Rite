/**
 * Shared access-request state + actions (ADR 0016), polled every 60s. Backs both the header
 * bell and the full Notifications page so they never drift. Grant seals the metaKey + itemsKey
 * to the requester (held by me as owner/editor), adds them as a viewer, then clears the request;
 * dismiss just clears it. The server only ever saw who-asked-for-which — never a key.
 */

import { useCallback, useEffect, useState } from 'react';
import { Backend, type IncomingRequest, type UserCollection } from '../utils/backend';
import { useServerSession } from './serverSessionStore';
import { unwrapCollectionKeys, sealCollectionKeyToHex } from '../utils/collectionCrypto';

export interface AccessRequestsController {
  requests: IncomingRequest[];
  mine: UserCollection[];
  busy: string | null;
  error: string | null;
  refresh: () => Promise<void>;
  grant: (r: IncomingRequest) => void;
  dismiss: (r: IncomingRequest) => void;
  keyOf: (r: IncomingRequest) => string;
}

export function useAccessRequests(): AccessRequestsController {
  const { publicKey, privateKey } = useServerSession();
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

  const keyOf = (r: IncomingRequest) => `${r.collectionId}:${r.userId}`;

  const run = (r: IncomingRequest, fn: () => Promise<unknown>) => {
    setBusy(keyOf(r));
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

  return { requests, mine, busy, error, refresh, grant, dismiss, keyOf };
}
