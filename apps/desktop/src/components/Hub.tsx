/**
 * The context hub (ADR 0014 phases 3/4) — the native front door.
 *
 * Before any authentication, the launch window shows this: the list of contexts
 * you can open — the local vault (master password) and each registered server
 * (its own login) — plus "add a server". Picking a context opens it in a window
 * (the shell's one-window-per-context registry focuses an already-open one). The
 * same component doubles as the in-workspace "Contexts" picker (an overlay with a
 * close button), so the header no longer needs a context dropdown.
 *
 * The roster lives in the local vault settings and is readable before unlock, so
 * the hub can list servers without a password. Native only — a web deployment is
 * served by one server and goes straight to that server's login.
 */

import { useCallback, useEffect, useState } from 'react';
import { Backend, type ContextState, type RemoteServer } from '../utils/backend';
import { requestOpenContext, nativeVaults, nativeContext, type NativeVault } from '../utils/nativeShell';
import { CertTrustModal } from './CertTrustModal';
import riteLandscape from '../assets/rite.png';

export interface HubProps {
  /** The context this window already holds, so the hub marks it "current". */
  current?: { kind: 'local' | 'server'; id?: string };
  /** Launch screen only: opening the local vault reuses THIS window. */
  onOpenLocalInPlace?: () => void;
  /** Overlay only: dismiss the picker (also used when picking the current context). */
  onClose?: () => void;
}

export function Hub({ current, onOpenLocalInPlace, onClose }: HubProps) {
  const [ctx, setCtx] = useState<ContextState | null>(null);
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingTrust, setPendingTrust] = useState<{ fingerprint: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setCtx(await Backend.Context.get());
    } catch {
      // No roster available (e.g. not yet reachable) — offer just the local vault.
      setCtx({ active: 'local', roster: [] });
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async initial load
    void refresh();
  }, [refresh]);

  const openLocal = () => {
    if (current?.kind === 'local') return onClose?.();
    if (onOpenLocalInPlace) onOpenLocalInPlace();
    else requestOpenContext({ kind: 'local' });
    onClose?.();
  };

  const openServer = (s: RemoteServer) => {
    if (current?.kind === 'server' && current.id === s.id) return onClose?.();
    requestOpenContext({ kind: 'server', id: s.id, url: s.url, label: s.label });
    onClose?.();
  };

  const commitAdd = useCallback(
    async (fingerprint?: string) => {
      const s = await Backend.Context.addServer(url.trim(), label.trim() || undefined);
      if (fingerprint) await Backend.Context.pinServer(s.id, fingerprint);
      setUrl('');
      setLabel('');
      setAdding(false);
      setPendingTrust(null);
      await refresh();
    },
    [url, label, refresh],
  );

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Probe the TLS cert first (ADR 0012 §4): a real cert is trusted straight
      // away; a self-signed one needs out-of-band fingerprint confirmation.
      const probe = await Backend.Context.probe(url.trim());
      if (!probe.trusted && probe.fingerprint) {
        setPendingTrust({ fingerprint: probe.fingerprint });
        return;
      }
      await commitAdd();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add server');
    } finally {
      setBusy(false);
    }
  };

  const confirmTrust = async () => {
    if (!pendingTrust) return;
    setBusy(true);
    setError(null);
    try {
      await commitAdd(pendingTrust.fingerprint);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add server');
      setPendingTrust(null);
    } finally {
      setBusy(false);
    }
  };

  const isCurrentLocal = current?.kind === 'local';
  // Multi-vault (ADR 0014): the shell injects the known local vaults; the hub lists them.
  const vaults = nativeVaults();
  const currentVaultPath = nativeContext()?.path ?? null;
  const openVault = (v: NativeVault) => {
    const isCurrent = isCurrentLocal && currentVaultPath === v.path;
    if (isCurrent) {
      onOpenLocalInPlace?.();
      return onClose?.();
    }
    // A different vault opens in its own window (the shell focuses it if already open).
    requestOpenContext({ kind: 'local', path: v.path });
    onClose?.();
  };

  return (
    <div className={onClose ? 'fixed inset-0 z-50 overflow-y-auto bg-background/95 backdrop-blur-sm' : 'min-h-screen overflow-y-auto bg-background'}>
      <div className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center gap-6 px-6 py-12 text-foreground">
        <div className="flex items-center justify-between">
          <img src={riteLandscape} alt="RITE" className="h-10 rounded-md" />
          {onClose && (
            <button
              onClick={onClose}
              className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
            >
              Close
            </button>
          )}
        </div>

        <div>
          <h1 className="text-2xl font-semibold">Contexts</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Open your local vault or a server. Each opens in its own window.
          </p>
        </div>

        {error && (
          <div className="rounded-md border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-600">
            {error}
          </div>
        )}

        <div className="flex flex-col gap-2">
          {/* Local vaults (multi-vault, ADR 0014). Fall back to a single card when the shell
              injected no roster (older shell / web build). */}
          {vaults.length > 0 ? (
            vaults.map((v) => {
              const isCurrent = isCurrentLocal && currentVaultPath === v.path;
              return (
                <button
                  key={v.path}
                  onClick={() => openVault(v)}
                  className="group flex items-center gap-3 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:border-primary hover:bg-muted"
                >
                  <span className="text-2xl" aria-hidden>
                    🔒
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{v.label}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      On this machine · unlocked with your master password
                    </span>
                  </span>
                  <span className="text-xs font-medium text-muted-foreground group-hover:text-primary">
                    {isCurrent ? 'Current' : 'Open'}
                  </span>
                </button>
              );
            })
          ) : (
            <button
              onClick={openLocal}
              className="group flex items-center gap-3 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:border-primary hover:bg-muted"
            >
              <span className="text-2xl" aria-hidden>
                🔒
              </span>
              <span className="flex-1">
                <span className="block font-medium">Local vault</span>
                <span className="block text-xs text-muted-foreground">
                  On this machine · unlocked with your master password
                </span>
              </span>
              <span className="text-xs font-medium text-muted-foreground group-hover:text-primary">
                {isCurrentLocal ? 'Current' : 'Open'}
              </span>
            </button>
          )}

          {/* Registered servers */}
          {ctx?.roster.map((s) => {
            const isCurrent = current?.kind === 'server' && current.id === s.id;
            return (
              <div
                key={s.id}
                className="group flex items-center gap-2 rounded-lg border border-border bg-card p-2 pr-3 transition-colors hover:border-primary"
              >
                <button
                  onClick={() => openServer(s)}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-md p-2 text-left hover:bg-muted"
                >
                  <span className="text-2xl" aria-hidden>
                    🖧
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    <span className="block truncate font-medium">{s.label || s.url}</span>
                    <span className="block truncate text-xs text-muted-foreground">{s.url}</span>
                  </span>
                  <span className="text-xs font-medium text-muted-foreground">
                    {isCurrent ? 'Current' : 'Open'}
                  </span>
                </button>
                <button
                  onClick={() => setConfirmRemove(s.id)}
                  title="Remove from this device"
                  aria-label={`Remove ${s.label || s.url}`}
                  className="flex-none rounded p-1.5 text-muted-foreground opacity-0 transition hover:bg-red-500/10 hover:text-red-500 group-hover:opacity-100"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2M6 7l1 13a2 2 0 002 2h6a2 2 0 002-2l1-13" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>

        {/* Add a server */}
        {adding ? (
          <form onSubmit={add} className="space-y-2 rounded-lg border border-border bg-card p-4">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://rite.example.com"
              className="w-full rounded border border-input bg-background px-3 py-2 text-sm"
              disabled={busy}
              autoFocus
            />
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Label (optional)"
              className="w-full rounded border border-input bg-background px-3 py-2 text-sm"
              disabled={busy}
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setAdding(false)}
                className="rounded px-3 py-1.5 text-sm hover:bg-muted"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy || !url.trim()}
                className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                Add server
              </button>
            </div>
          </form>
        ) : (
          <button
            onClick={() => setAdding(true)}
            className="rounded-lg border border-dashed border-border px-4 py-3 text-sm font-medium text-muted-foreground hover:border-primary hover:text-foreground"
          >
            ＋ Add a server
          </button>
        )}
      </div>

      {pendingTrust && (
        <CertTrustModal
          url={url.trim()}
          fingerprint={pendingTrust.fingerprint}
          busy={busy}
          onTrust={confirmTrust}
          onCancel={() => setPendingTrust(null)}
        />
      )}

      {confirmRemove &&
        (() => {
          const s = ctx?.roster.find((x) => x.id === confirmRemove);
          if (!s) return null;
          return (
            <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
              <div className="w-full max-w-sm rounded-lg border border-border bg-card p-5 shadow-xl">
                <h3 className="font-semibold">Remove “{s.label || s.url}”?</h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  This only removes the server from <strong>this device</strong>. Your account on the
                  server is <strong>not</strong> deleted — add it again anytime with its URL and sign
                  in with your password.
                </p>
                <div className="mt-4 flex justify-end gap-2">
                  <button
                    onClick={() => setConfirmRemove(null)}
                    disabled={busy}
                    className="rounded-md px-3 py-1.5 text-sm hover:bg-muted"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await Backend.Context.removeServer(s.id);
                        setConfirmRemove(null);
                        await refresh();
                      } catch (err) {
                        setError(err instanceof Error ? err.message : 'Failed to remove server');
                      } finally {
                        setBusy(false);
                      }
                    }}
                    disabled={busy}
                    className="rounded-md bg-red-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
    </div>
  );
}
