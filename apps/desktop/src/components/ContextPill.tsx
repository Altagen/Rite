/**
 * Context pill (ADR 0014 — navigation skeleton, transposed from design/mock).
 *
 * The header's context switcher: a pill showing the active context (local vault or
 * a server) with a dropdown to switch quickly, plus "Manage…" which opens the full
 * context manager ({@link Hub}). Native only — a web deployment is served by one
 * server, so there is nothing to switch and this renders nothing.
 *
 * Switching a context opens (or focuses) it in its own window via the shell's
 * one-window-per-context registry (`requestOpenContext`); picking the context this
 * window already holds just closes the dropdown.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Backend, type ContextState, type RemoteServer } from '../utils/backend';
import {
  isNativeShell,
  requestOpenContext,
  requestSwitchContext,
  nativeVaults,
  nativeContext,
  sendVaultCommand,
  onVaultsChanged,
  openCreateVault,
  type NativeVault,
} from '../utils/nativeShell';
import { Hub } from './Hub';
import { ContextDot, ContextTag, type ContextTagState } from './ContextTag';
import { useAuthStore } from '../store/authStore';
import { VaultRemoveDialog } from './VaultRemoveDialog';

export function ContextPill() {
  const [ctx, setCtx] = useState<ContextState | null>(null);
  const [open, setOpen] = useState(false);
  const [showManager, setShowManager] = useState(false);
  const [removeVault, setRemoveVault] = useState<NativeVault | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const isLocked = useAuthStore((s) => s.isLocked);

  const refresh = useCallback(async () => {
    try {
      setCtx(await Backend.Context.get());
    } catch {
      // No context control plane here — offer just the local vault.
      setCtx({ active: 'local', roster: [] });
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async initial load
    if (isNativeShell()) void refresh();
  }, [refresh]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);
  // Re-render when the shell pushes a roster change (ADR 0014).
  const [, bumpVaults] = useState(0);
  useEffect(() => onVaultsChanged(() => bumpVaults((n) => n + 1)), []);

  if (!isNativeShell()) return null;

  const active = ctx?.active;
  const isLocalActive = !active || active === 'local';
  const vaults = nativeVaults();
  const currentVaultPath = nativeContext()?.path ?? null;
  // This window's vault is the only one whose lock state we can know (ADR 0014: one
  // window, one vault). Any other roster entry has no server running, so it is locked
  // — see ContextTag.
  const vaultState = (path: string | null): ContextTagState =>
    isLocalActive && path !== null && path === currentVaultPath && !isLocked ? 'open' : 'locked';
  const currentVault = vaults.find((v) => v.path === currentVaultPath);
  // No registered vault under this window yet (fresh install, register-after-password) ⇒ don't
  // pretend there's a "Local vault"; show it's not set up.
  const currentLabel = isLocalActive
    ? (currentVault?.label ?? (vaults.length === 0 ? 'No vault' : 'Local vault'))
    : active.label || active.url;

  // Default action: switch THIS window in place (locks the current vault). "Open in new
  // window" (the split button) keeps the current context and opens the target beside it.
  const openVault = (path: string) => {
    setOpen(false);
    if (!(isLocalActive && currentVaultPath === path)) requestSwitchContext({ kind: 'local', path });
  };
  const openServer = (s: RemoteServer) => {
    setOpen(false);
    const isCurrent = !isLocalActive && active.id === s.id;
    if (!isCurrent) requestSwitchContext({ kind: 'server', id: s.id, url: s.url, label: s.label });
  };
  const newWindowVault = (path: string) => {
    setOpen(false);
    requestOpenContext({ kind: 'local', path });
  };
  const newWindowServer = (s: RemoteServer) => {
    setOpen(false);
    requestOpenContext({ kind: 'server', id: s.id, url: s.url, label: s.label });
  };

  const chevron = (
    <svg className="h-3 w-3 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
  const splitIcon = (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M14 3h7v7m0-7l-9 9M10 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-4" />
    </svg>
  );
  // A row = a wide "switch this window" button + a visible "open in new window" action (kept
  // discoverable, not hover-only) and a hover-only remove.
  const newWindowBtn = (label: string, onClick: () => void) => (
    <button
      onClick={onClick}
      title="Open in a new window"
      aria-label={`Open ${label} in a new window`}
      className="flex-none rounded p-1.5 text-muted-foreground opacity-70 transition hover:bg-background hover:text-foreground hover:opacity-100"
    >
      {splitIcon}
    </button>
  );
  const removeVaultBtn = (v: NativeVault) => {
    // The current vault opens the Reset flow (you can't forget the one you're in); others open
    // the remove/delete flow. The dialog decides — keep the label neutral for both.
    const current = isLocalActive && currentVaultPath === v.path;
    return (
    <button
      onClick={() => {
        setOpen(false);
        setRemoveVault(v);
      }}
      title={current ? 'Reset vault' : 'Remove from list'}
      aria-label={current ? `Reset ${v.label}` : `Remove ${v.label}`}
      className="flex-none rounded p-1.5 text-muted-foreground opacity-0 transition hover:bg-red-500/10 hover:text-red-500 group-hover:opacity-100"
    >
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2M6 7l1 13a2 2 0 002 2h6a2 2 0 002-2l1-13" />
      </svg>
    </button>
    );
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm font-medium hover:bg-muted"
        title="Switch context"
      >
        <ContextDot state={isLocalActive ? vaultState(currentVaultPath) : 'server'} />
        <span className="max-w-[180px] truncate">{currentLabel}</span>
        {chevron}
      </button>

      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-72 rounded-md border border-border bg-card p-1 shadow-lg">
          <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Local vaults
          </p>
          {vaults.length > 0 ? (
            vaults.map((v) => {
              const isCurrent = isLocalActive && currentVaultPath === v.path;
              return (
                <div
                  key={v.path}
                  className={`group flex items-center gap-1 rounded ${isCurrent ? 'bg-primary/10' : 'hover:bg-muted'}`}
                >
                  <button
                    onClick={() => openVault(v.path)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left text-sm"
                  >
                    {v.icon?.startsWith('data:') ? (
                      <img src={v.icon} alt="" className="h-4 w-4 flex-none rounded object-cover" />
                    ) : (
                      <span className="flex-none text-sm leading-none">{v.icon || '🔒'}</span>
                    )}
                    <span className="min-w-0 flex-1 truncate">{v.label}</span>
                    {isCurrent && <span className="flex-none text-xs text-primary">current</span>}
                    <ContextTag state={vaultState(v.path)} />
                  </button>
                  {!isCurrent && newWindowBtn(v.label, () => newWindowVault(v.path))}
                  {removeVaultBtn(v)}
                </div>
              );
            })
          ) : (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">
              No vault yet — create one below.
            </p>
          )}

          {ctx && ctx.roster.length > 0 && (
            <>
              <p className="px-2 py-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Servers
              </p>
              {ctx.roster.map((s) => {
                const isCurrent = !isLocalActive && active.id === s.id;
                return (
                  <div
                    key={s.id}
                    className={`group flex items-center gap-1 rounded ${isCurrent ? 'bg-primary/10' : 'hover:bg-muted'}`}
                  >
                    <button
                      onClick={() => openServer(s)}
                      className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left text-sm"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{s.label || s.url}</span>
                        <span className="block truncate text-xs text-muted-foreground">{s.url}</span>
                      </span>
                      {isCurrent && <span className="text-xs text-primary">current</span>}
                      <ContextTag state="server" />
                    </button>
                    {!isCurrent && newWindowBtn(s.label || s.url, () => newWindowServer(s))}
                  </div>
                );
              })}
            </>
          )}

          <div className="my-1 border-t border-border" />
          {!isLocalActive && (
            <button
              onClick={() => {
                setOpen(false);
                requestOpenContext({ kind: 'local' });
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
              title="Open your local vault in a separate window, alongside this one"
            >
              {splitIcon} Open a local window
            </button>
          )}
          <button
            onClick={() => {
              setOpen(false);
              openCreateVault();
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <span aria-hidden>＋</span> New local vault…
          </button>
          <button
            onClick={() => {
              setOpen(false);
              sendVaultCommand({ type: 'vault-open-file' });
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <span aria-hidden>📂</span> Open a vault file…
          </button>
          <button
            onClick={() => {
              setOpen(false);
              setShowManager(true);
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Manage contexts…
          </button>
        </div>
      )}

      {showManager && (
        <Hub
          current={isLocalActive ? { kind: 'local' } : { kind: 'server', id: active.id }}
          onClose={() => {
            setShowManager(false);
            void refresh();
          }}
        />
      )}

      {removeVault && (
        <VaultRemoveDialog vault={removeVault} onClose={() => setRemoveVault(null)} />
      )}
    </div>
  );
}
