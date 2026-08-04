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
import { useAuthStore } from '../store/authStore';
import {
  requestOpenContext,
  nativeVaults,
  nativeContext,
  sendVaultCommand,
  onVaultsChanged,
  type NativeVault,
} from '../utils/nativeShell';
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

const VAULT_EMOJI = ['🔒', '🚀', '🏠', '🖥️', '☁️', '🐳', '🗄️', '🔧', '🧪', '🌐', '🛡️', '📦'];

/** Render a context icon: a `data:` image, an emoji, or a fallback glyph. */
function IconGlyph({ icon, fallback }: { icon?: string; fallback: string }) {
  if (icon?.startsWith('data:'))
    return <img src={icon} alt="" className="h-7 w-7 flex-none rounded object-cover" />;
  return (
    <span className="text-2xl leading-none" aria-hidden>
      {icon || fallback}
    </span>
  );
}

/** Downscale a picked image to a small square PNG data URI so the roster stays lightweight. */
function fileToIconDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('no canvas'));
        ctx.drawImage(img, 0, 0, 64, 64);
        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = () => reject(new Error('bad image'));
      img.src = String(reader.result);
    };
    reader.onerror = () => reject(new Error('read failed'));
    reader.readAsDataURL(file);
  });
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
  const [confirmRemoveVault, setConfirmRemoveVault] = useState<NativeVault | null>(null); // remove/delete a vault
  const [deleteVaultFile, setDeleteVaultFile] = useState(false); // opt-in: also erase the file
  const [editingId, setEditingId] = useState<string | null>(null); // editing a roster server
  // Multi-vault (ADR 0014): re-render when the shell pushes a roster change; inline rename state.
  const [, bumpVaults] = useState(0);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameLabel, setRenameLabel] = useState('');

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

  // The shell fires `rite-vaults-changed` after a vault command → re-read window.__RITE_VAULTS__.
  useEffect(() => onVaultsChanged(() => bumpVaults((n) => n + 1)), []);

  const openLocal = () => {
    if (current?.kind === 'local') return onClose?.();
    if (onOpenLocalInPlace) onOpenLocalInPlace();
    else requestOpenContext({ kind: 'local' });
    onClose?.();
  };

  // Server icons (ADR 0014): emoji or a device-local image, stored in the roster via the backend.
  const [serverIconMenu, setServerIconMenu] = useState<string | null>(null);
  const setServerEmoji = async (s: RemoteServer, icon: string) => {
    await Backend.Context.setServerIcon(s.id, icon).catch(() => {});
    setServerIconMenu(null);
    await refresh();
  };
  const setServerImage = (s: RemoteServer) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return;
      void fileToIconDataUri(f)
        .then((uri) => Backend.Context.setServerIcon(s.id, uri))
        .then(() => {
          setServerIconMenu(null);
          return refresh();
        })
        .catch(() => {});
    };
    input.click();
  };
  const clearServerIcon = async (s: RemoteServer) => {
    await Backend.Context.setServerIcon(s.id).catch(() => {});
    setServerIconMenu(null);
    await refresh();
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

  const startEditServer = (s: RemoteServer) => {
    setEditingId(s.id);
    setUrl(s.url);
    setLabel(s.label || '');
    setAdding(true);
  };
  const cancelForm = () => {
    setAdding(false);
    setEditingId(null);
    setUrl('');
    setLabel('');
    setError(null);
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Editing an existing server: just save url/label (a changed URL re-pins on connect).
      if (editingId) {
        await Backend.Context.updateServer(editingId, url.trim(), label.trim() || undefined);
        cancelForm();
        await refresh();
        return;
      }
      // Adding: probe the TLS cert first (ADR 0012 §4): a real cert is trusted straight
      // away; a self-signed one needs out-of-band fingerprint confirmation.
      const probe = await Backend.Context.probe(url.trim());
      if (!probe.trusted && probe.fingerprint) {
        setPendingTrust({ fingerprint: probe.fingerprint });
        return;
      }
      await commitAdd();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save server');
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

  // Vault management (ADR 0014). The shell runs the command (native dialog for new/open) and
  // pushes the updated roster back via `rite-vaults-changed`, so we don't refresh by hand.
  const newVault = () => sendVaultCommand({ type: 'vault-new' });
  const openVaultFile = () => sendVaultCommand({ type: 'vault-open-file' });
  const startRename = (v: NativeVault) => {
    setRenamingPath(v.path);
    setRenameLabel(v.label);
  };
  const commitRename = () => {
    const label = renameLabel.trim();
    if (renamingPath && label) sendVaultCommand({ type: 'vault-rename', path: renamingPath, label });
    setRenamingPath(null);
  };
  // Lock the current window's vault (in-session; re-requires the master password). Only the
  // current vault can be locked from here — other vaults live in their own windows.
  const lockCurrent = useAuthStore((s) => s.lock);
  const lockVault = () => {
    void lockCurrent();
    onClose?.();
  };
  // Vault icon (ADR 0014): an emoji or a device-local image, per-vault, device-local.
  const [iconMenuPath, setIconMenuPath] = useState<string | null>(null);
  const setVaultEmoji = (v: NativeVault, icon: string) => {
    sendVaultCommand({ type: 'vault-set-icon', path: v.path, icon });
    setIconMenuPath(null);
  };
  const setVaultImage = (v: NativeVault) => {
    sendVaultCommand({ type: 'vault-set-image', path: v.path });
    setIconMenuPath(null);
  };
  const clearVaultIcon = (v: NativeVault) => {
    sendVaultCommand({ type: 'vault-set-icon', path: v.path });
    setIconMenuPath(null);
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
              const renaming = renamingPath === v.path;
              return (
                <div
                  key={v.path}
                  className="group flex items-center gap-2 rounded-lg border border-border bg-card p-2 pr-3 transition-colors hover:border-primary"
                >
                  {renaming ? (
                    <div className="flex flex-1 items-center gap-3 p-2">
                      <span className="text-2xl" aria-hidden>
                        🔒
                      </span>
                      <input
                        autoFocus
                        value={renameLabel}
                        onChange={(e) => setRenameLabel(e.target.value)}
                        onBlur={commitRename}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitRename();
                          if (e.key === 'Escape') setRenamingPath(null);
                        }}
                        aria-label="Vault name"
                        className="w-full rounded border border-input bg-background px-2 py-1 text-sm"
                      />
                    </div>
                  ) : (
                    <>
                      <button
                        onClick={() => openVault(v)}
                        className="flex min-w-0 flex-1 items-center gap-3 rounded-md p-2 text-left hover:bg-muted"
                      >
                        <IconGlyph icon={v.icon} fallback="🔒" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{v.label}</span>
                          <span className="block truncate text-xs text-muted-foreground">{v.path}</span>
                        </span>
                        <span className="text-xs font-medium text-muted-foreground">
                          {isCurrent ? 'Current' : 'Open'}
                        </span>
                      </button>
                      <div className="relative flex-none">
                        <button
                          onClick={() => setIconMenuPath(iconMenuPath === v.path ? null : v.path)}
                          title="Change icon"
                          aria-label={`Change icon for ${v.label}`}
                          className="rounded p-1.5 text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground group-hover:opacity-100"
                        >
                          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <rect x="3" y="3" width="18" height="18" rx="2" />
                            <circle cx="8.5" cy="8.5" r="1.5" />
                            <path strokeLinecap="round" strokeLinejoin="round" d="M21 15l-5-5L5 21" />
                          </svg>
                        </button>
                        {iconMenuPath === v.path && (
                          <div className="absolute right-0 top-full z-30 mt-1 w-56 rounded-md border border-border bg-card p-2 shadow-lg">
                            <div className="grid grid-cols-6 gap-1">
                              {VAULT_EMOJI.map((emo) => (
                                <button
                                  key={emo}
                                  onClick={() => setVaultEmoji(v, emo)}
                                  className="rounded p-1 text-xl hover:bg-muted"
                                >
                                  {emo}
                                </button>
                              ))}
                            </div>
                            <div className="mt-2 flex items-center justify-between border-t border-border pt-2 text-xs">
                              <button onClick={() => setVaultImage(v)} className="rounded px-2 py-1 font-medium hover:bg-muted">
                                Image…
                              </button>
                              <button
                                onClick={() => clearVaultIcon(v)}
                                className="rounded px-2 py-1 text-muted-foreground hover:bg-muted"
                              >
                                Reset
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                      {isCurrent && (
                        <button
                          onClick={lockVault}
                          title="Lock"
                          aria-label={`Lock ${v.label}`}
                          className="flex-none rounded p-1.5 text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground group-hover:opacity-100"
                        >
                          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <rect x="5" y="11" width="14" height="10" rx="2" />
                            <path strokeLinecap="round" d="M8 11V7a4 4 0 118 0v4" />
                          </svg>
                        </button>
                      )}
                      <button
                        onClick={() => startRename(v)}
                        title="Rename"
                        aria-label={`Rename ${v.label}`}
                        className="flex-none rounded p-1.5 text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground group-hover:opacity-100"
                      >
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z" />
                        </svg>
                      </button>
                      <button
                        onClick={() => {
                          setDeleteVaultFile(false);
                          setConfirmRemoveVault(v);
                        }}
                        title="Remove from list"
                        aria-label={`Remove ${v.label} from the list`}
                        className="flex-none rounded p-1.5 text-muted-foreground opacity-0 transition hover:bg-red-500/10 hover:text-red-500 group-hover:opacity-100"
                      >
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2M6 7l1 13a2 2 0 002 2h6a2 2 0 002-2l1-13" />
                        </svg>
                      </button>
                    </>
                  )}
                </div>
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

          {/* New / open a vault file (multi-vault, ADR 0014) — native shell only. */}
          {vaults.length > 0 && (
            <div className="flex gap-2">
              <button
                onClick={newVault}
                className="flex flex-1 items-center gap-2 rounded-lg border border-dashed border-border p-3 text-left text-sm text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
              >
                <span className="text-lg leading-none" aria-hidden>
                  ＋
                </span>
                New local vault…
              </button>
              <button
                onClick={openVaultFile}
                className="flex flex-1 items-center gap-2 rounded-lg border border-dashed border-border p-3 text-left text-sm text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
              >
                <span className="text-lg leading-none" aria-hidden>
                  📂
                </span>
                Open a vault file…
              </button>
            </div>
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
                  <IconGlyph icon={s.icon} fallback="🖧" />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="block truncate font-medium">{s.label || s.url}</span>
                    <span className="block truncate text-xs text-muted-foreground">{s.url}</span>
                  </span>
                  <span className="text-xs font-medium text-muted-foreground">
                    {isCurrent ? 'Current' : 'Open'}
                  </span>
                </button>
                <div className="relative flex-none">
                  <button
                    onClick={() => setServerIconMenu(serverIconMenu === s.id ? null : s.id)}
                    title="Change icon"
                    aria-label={`Change icon for ${s.label || s.url}`}
                    className="rounded p-1.5 text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground group-hover:opacity-100"
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                      <circle cx="8.5" cy="8.5" r="1.5" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M21 15l-5-5L5 21" />
                    </svg>
                  </button>
                  {serverIconMenu === s.id && (
                    <div className="absolute right-0 top-full z-30 mt-1 w-56 rounded-md border border-border bg-card p-2 shadow-lg">
                      <div className="grid grid-cols-6 gap-1">
                        {VAULT_EMOJI.map((emo) => (
                          <button
                            key={emo}
                            onClick={() => void setServerEmoji(s, emo)}
                            className="rounded p-1 text-xl hover:bg-muted"
                          >
                            {emo}
                          </button>
                        ))}
                      </div>
                      <div className="mt-2 flex items-center justify-between border-t border-border pt-2 text-xs">
                        <button onClick={() => setServerImage(s)} className="rounded px-2 py-1 font-medium hover:bg-muted">
                          Image…
                        </button>
                        <button
                          onClick={() => void clearServerIcon(s)}
                          className="rounded px-2 py-1 text-muted-foreground hover:bg-muted"
                        >
                          Reset
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                <button
                  onClick={() => startEditServer(s)}
                  title="Edit URL / label"
                  aria-label={`Edit ${s.label || s.url}`}
                  className="flex-none rounded p-1.5 text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground group-hover:opacity-100"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z" />
                  </svg>
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
                onClick={cancelForm}
                className="rounded px-3 py-1.5 text-sm hover:bg-muted"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy || !url.trim()}
                className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                {editingId ? 'Save' : 'Add server'}
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

      {confirmRemoveVault && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-lg border border-border bg-card p-5 shadow-xl">
            <h3 className="font-semibold">Remove “{confirmRemoveVault.label}”?</h3>
            <p className="mt-1 truncate text-xs text-muted-foreground">{confirmRemoveVault.path}</p>
            <p className="mt-3 text-sm text-muted-foreground">
              Removes this vault from your list. The database file stays on disk — you can open it
              again anytime.
            </p>
            <label className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-lg border border-red-500/30 bg-red-500/5 p-3">
              <input
                type="checkbox"
                checked={deleteVaultFile}
                onChange={(e) => setDeleteVaultFile(e.target.checked)}
                className="mt-0.5 h-4 w-4 flex-none accent-red-500"
              />
              <span className="min-w-0 text-sm">
                <span className="font-medium text-red-500">Also delete the file permanently</span>
                <span className="block text-xs text-muted-foreground">
                  Irreversible — erases the database and all its connections.
                </span>
              </span>
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setConfirmRemoveVault(null)}
                className="rounded-md px-3 py-1.5 text-sm hover:bg-muted"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  sendVaultCommand(
                    deleteVaultFile
                      ? { type: 'vault-delete', path: confirmRemoveVault.path }
                      : { type: 'vault-forget', path: confirmRemoveVault.path },
                  );
                  setConfirmRemoveVault(null);
                }}
                className="rounded-md bg-red-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-600"
              >
                {deleteVaultFile ? 'Delete permanently' : 'Remove'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
