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
import { isNativeShell, requestOpenContext } from '../utils/nativeShell';
import { Hub } from './Hub';

export function ContextPill() {
  const [ctx, setCtx] = useState<ContextState | null>(null);
  const [open, setOpen] = useState(false);
  const [showManager, setShowManager] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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

  if (!isNativeShell()) return null;

  const active = ctx?.active;
  const isLocalActive = !active || active === 'local';
  const currentLabel = isLocalActive ? 'Local vault' : active.label || active.url;

  const openLocal = () => {
    setOpen(false);
    if (!isLocalActive) requestOpenContext({ kind: 'local' });
  };
  const openServer = (s: RemoteServer) => {
    setOpen(false);
    const isCurrent = !isLocalActive && active.id === s.id;
    if (!isCurrent) requestOpenContext({ kind: 'server', id: s.id, url: s.url, label: s.label });
  };

  const chevron = (
    <svg className="h-3 w-3 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm font-medium hover:bg-muted"
        title="Switch context"
      >
        <span className={`h-2 w-2 flex-none rounded-full ${isLocalActive ? 'bg-amber-400' : 'bg-purple-400'}`} />
        <span className="max-w-[180px] truncate">{currentLabel}</span>
        {chevron}
      </button>

      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-72 rounded-md border border-border bg-card p-1 shadow-lg">
          <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Local
          </p>
          <button
            onClick={openLocal}
            className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted ${
              isLocalActive ? 'bg-primary/10' : ''
            }`}
          >
            <span className="h-2 w-2 flex-none rounded-full bg-amber-400" />
            <span className="flex-1 truncate">Local vault</span>
            {isLocalActive && <span className="text-xs text-primary">current</span>}
          </button>

          {ctx && ctx.roster.length > 0 && (
            <>
              <p className="px-2 py-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Servers
              </p>
              {ctx.roster.map((s) => {
                const isCurrent = !isLocalActive && active.id === s.id;
                return (
                  <button
                    key={s.id}
                    onClick={() => openServer(s)}
                    className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted ${
                      isCurrent ? 'bg-primary/10' : ''
                    }`}
                  >
                    <span className="h-2 w-2 flex-none rounded-full bg-purple-400" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{s.label || s.url}</span>
                      <span className="block truncate text-xs text-muted-foreground">{s.url}</span>
                    </span>
                    {isCurrent && <span className="text-xs text-primary">current</span>}
                  </button>
                );
              })}
            </>
          )}

          <div className="my-1 border-t border-border" />
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
    </div>
  );
}
