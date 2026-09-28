/**
 * Shared state for running port forwards.
 *
 * A forward exists in two places: saved on the machine (what you configured) and
 * running in the core (what is actually listening). The dashboard card and the
 * manage modal both need to pair the two, so the pairing lives here rather than
 * being written twice and drifting.
 */

import { useCallback, useEffect, useState } from 'react';
import { Backend, type PortForwardInfo } from './backend';
import type { PortForwardConfig } from '../store/connectionsStore';

/**
 * Stable identity for a forward. The core assigns a random id when one starts, so
 * a saved row is matched to a running one by what it does, not by id.
 */
export const forwardKey = (f: {
  localPort: number;
  remoteHost: string;
  remotePort: number;
}) => `${f.localPort}|${f.remoteHost}|${f.remotePort}`;

/** Which of a machine's forwards are live, keyed by {@link forwardKey} → running id. */
export function useRunningForwards(connectionId: string) {
  const [running, setRunning] = useState<Map<string, string>>(new Map());

  const reconcile = useCallback(async () => {
    try {
      const live: PortForwardInfo[] = await Backend.Terminal.listForwards();
      const mine = new Map<string, string>();
      for (const f of live) {
        if (f.connectionId === connectionId) mine.set(forwardKey(f), f.id);
      }
      setRunning(mine);
    } catch {
      // Listing is advisory: a failure here must not blank the card.
    }
  }, [connectionId]);

  useEffect(() => {
    // Defer out of the effect body so the initial load's setState isn't
    // synchronous — same shape the dashboard's probes use.
    const t = setTimeout(() => void reconcile(), 0);
    return () => clearTimeout(t);
  }, [reconcile]);

  const start = useCallback(
    async (f: PortForwardConfig, startFn: (f: PortForwardConfig) => Promise<PortForwardInfo>) => {
      const info = await startFn(f);
      setRunning((m) => new Map(m).set(forwardKey(f), info.id));
    },
    [],
  );

  const stop = useCallback(async (f: PortForwardConfig) => {
    const key = forwardKey(f);
    const id = running.get(key);
    if (!id) return;
    await Backend.Terminal.stopForward(id);
    setRunning((m) => {
      const next = new Map(m);
      next.delete(key);
      return next;
    });
  }, [running]);

  return { running, reconcile, start, stop, isLive: (f: PortForwardConfig) => running.has(forwardKey(f)) };
}
