/**
 * Port Forwarding Modal
 *
 * Manage a machine's saved local port forwards: add/remove (persisted on the
 * connection) and start/stop them live. A local forward binds 127.0.0.1:localPort
 * on this machine and tunnels it over SSH — through the connection's jump host too,
 * if it has one — to remoteHost:remotePort as seen from the SSH host. Remote and
 * dynamic (SOCKS) forwards are shown as reserved but not yet built.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from '../i18n/i18n';
import { Backend, type PortForwardInfo } from '../utils/backend';
import type { ConnectionInfo, PortForwardConfig } from '../store/connectionsStore';

interface Props {
  connection: ConnectionInfo;
  // Persist the updated forward list on the connection.
  onPersist: (forwards: PortForwardConfig[]) => Promise<void>;
  // Start a forward through the active connection source (vault by id, accounts by
  // decrypted target). Absent ⇒ this source can't run forwards; rows stay read-only.
  onStart?: (forward: PortForwardConfig) => Promise<PortForwardInfo>;
  onClose: () => void;
}

// Stable identity for a forward config, to pair a saved row with a running one.
const keyOf = (f: { localPort: number; remoteHost: string; remotePort: number }) =>
  `${f.localPort}|${f.remoteHost}|${f.remotePort}`;

export function PortForwardModal({ connection, onPersist, onStart, onClose }: Props) {
  const { t } = useTranslation();
  const [forwards, setForwards] = useState<PortForwardConfig[]>(connection.forwards ?? []);
  // configKey → running forward id (present ⇒ live).
  const [running, setRunning] = useState<Map<string, string>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lp, setLp] = useState('');
  const [rh, setRh] = useState('');
  const [rp, setRp] = useState('');

  // Reconcile with the backend's live forwards for this connection on mount.
  useEffect(() => {
    let cancelled = false;
    Backend.Terminal.listForwards()
      .then((list: PortForwardInfo[]) => {
        if (cancelled) return;
        const mine = new Map<string, string>();
        for (const f of list) {
          if (f.connectionId === connection.id) mine.set(keyOf(f), f.id);
        }
        setRunning(mine);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [connection.id]);

  const persist = async (next: PortForwardConfig[]) => {
    setForwards(next);
    try {
      await onPersist(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const addForward = async () => {
    const localPort = Number(lp);
    const remotePort = Number(rp);
    if (!localPort || !rh.trim() || !remotePort) {
      setError(t('pf.fillAll'));
      return;
    }
    setError(null);
    await persist([
      ...forwards,
      { forwardType: 'local', localPort, remoteHost: rh.trim(), remotePort },
    ]);
    setLp('');
    setRh('');
    setRp('');
  };

  const removeForward = async (idx: number) => {
    const f = forwards[idx];
    const id = running.get(keyOf(f));
    if (id) await stop(f); // stop it first if live
    await persist(forwards.filter((_, i) => i !== idx));
  };

  const start = async (f: PortForwardConfig) => {
    if (!onStart) return;
    setBusy(keyOf(f));
    setError(null);
    try {
      const info = await onStart(f);
      setRunning((m) => new Map(m).set(keyOf(f), info.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const stop = async (f: PortForwardConfig) => {
    const id = running.get(keyOf(f));
    if (!id) return;
    setBusy(keyOf(f));
    try {
      await Backend.Terminal.stopForward(id);
      setRunning((m) => {
        const n = new Map(m);
        n.delete(keyOf(f));
        return n;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('pf.title')}
        className="w-full max-w-2xl overflow-hidden rounded-lg border border-border bg-background shadow-xl"
      >
        <div className="border-b border-border px-4 py-3">
          <div className="text-sm font-medium">{t('pf.title')}</div>
          <div className="truncate text-xs text-muted-foreground">
            {connection.name} — {connection.username}@{connection.hostname}
          </div>
        </div>

        <div className="max-h-[60vh] overflow-y-auto px-4 py-3">
          {forwards.length === 0 ? (
            <p className="mb-3 text-sm text-muted-foreground">{t('pf.empty')}</p>
          ) : (
            <ul className="mb-3 flex flex-col gap-1.5">
              {forwards.map((f, i) => {
                const live = running.has(keyOf(f));
                const isBusy = busy === keyOf(f);
                return (
                  <li
                    key={`${keyOf(f)}-${i}`}
                    className="flex items-center gap-2 rounded border border-border bg-muted/40 px-2.5 py-1.5"
                  >
                    <span className="rounded border border-border px-1.5 py-px text-[11px] font-bold text-primary">
                      L
                    </span>
                    <span className="flex-1 truncate font-mono text-xs">
                      127.0.0.1:{f.localPort} → {f.remoteHost}:{f.remotePort}
                    </span>
                    <span
                      className={`h-2 w-2 flex-none rounded-full ${live ? 'bg-green-500' : 'bg-muted-foreground/40'}`}
                      title={live ? t('pf.listening') : t('pf.stopped')}
                    />
                    <button
                      type="button"
                      disabled={isBusy || (!live && !onStart)}
                      title={!live && !onStart ? t('pf.unsupportedHere') : undefined}
                      onClick={() => (live ? stop(f) : start(f))}
                      className="rounded border border-border px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-50"
                    >
                      {live ? t('pf.stop') : t('pf.start')}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeForward(i)}
                      className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                      title={t('pf.remove')}
                    >
                      ✕
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="mb-2 flex gap-1.5 text-xs">
            <span className="rounded border border-primary px-2 py-1 text-primary">{t('pf.local')}</span>
            <span className="rounded border border-border px-2 py-1 text-muted-foreground" title={t('pf.soon')}>
              {t('pf.remote')}
            </span>
            <span className="rounded border border-border px-2 py-1 text-muted-foreground" title={t('pf.soon')}>
              {t('pf.dynamic')}
            </span>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">{t('pf.localPort')}</span>
              <input
                value={lp}
                onChange={(e) => setLp(e.target.value)}
                inputMode="numeric"
                placeholder="5432"
                className="w-24 rounded border border-border bg-input px-2 py-1.5 font-mono text-sm"
              />
            </label>
            <span className="pb-2 text-muted-foreground">→</span>
            <label className="flex flex-1 flex-col gap-1 text-xs">
              <span className="text-muted-foreground">{t('pf.remoteHost')}</span>
              <input
                value={rh}
                onChange={(e) => setRh(e.target.value)}
                placeholder="db.internal or localhost"
                className="w-full min-w-[150px] rounded border border-border bg-input px-2 py-1.5 font-mono text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">{t('pf.remotePort')}</span>
              <input
                value={rp}
                onChange={(e) => setRp(e.target.value)}
                inputMode="numeric"
                placeholder="5432"
                className="w-24 rounded border border-border bg-input px-2 py-1.5 font-mono text-sm"
              />
            </label>
            <button
              type="button"
              onClick={addForward}
              className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              {t('pf.add')}
            </button>
          </div>

          <p className="mt-2 text-xs text-muted-foreground">{t('pf.hint', { name: connection.name })}</p>
          {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
        </div>

        <div className="flex justify-end border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-border px-3 py-1.5 text-sm hover:bg-muted"
          >
            {t('pf.done')}
          </button>
        </div>
      </div>
    </div>
  );
}
