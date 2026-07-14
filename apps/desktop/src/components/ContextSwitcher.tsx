/**
 * Context switcher (ADR 0012 phase 1).
 *
 * The native client keeps a roster of contexts — the local vault + saved remote
 * servers — with exactly one active (ADR 0006). This shows the active context
 * and lets you add/remove servers and pick one. Actually connecting to a remote
 * (the proxy) lands in phase 2; for now selecting one records the active context.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Backend, type ContextState } from '../utils/backend';

export function ContextSwitcher() {
  const [ctx, setCtx] = useState<ContextState | null>(null);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      setCtx(await Backend.Context.get());
    } catch {
      // leave as-is
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async initial load
    refresh();
  }, [refresh]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const activeLabel =
    ctx && ctx.active !== 'local' ? ctx.active.label : 'Local';

  const select = async (server: string) => {
    setBusy(true);
    setError(null);
    try {
      await Backend.Context.setActive(server);
      // Switching context reboots the app: it re-reads the (now proxied) mode and
      // lands on the local vault or the remote's login (ADR 0012 / 0006).
      window.location.reload();
    } catch {
      setError('Failed to switch context');
      setBusy(false);
    }
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await Backend.Context.addServer(url.trim(), label.trim() || undefined);
      setUrl('');
      setLabel('');
      setAdding(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add server');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await Backend.Context.removeServer(id);
      await refresh();
    } catch {
      setError('Failed to remove server');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm font-medium hover:bg-muted"
        title="Switch context"
      >
        <span className="text-xs text-muted-foreground">Context</span>
        <span>{activeLabel}</span>
        <svg className="h-3 w-3 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-72 rounded-md border border-border bg-card p-1 shadow-lg">
          {error && <p className="px-2 py-1 text-xs text-red-500">{error}</p>}

          <button
            onClick={() => select('local')}
            disabled={busy}
            className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-muted ${
              ctx?.active === 'local' ? 'font-medium' : ''
            }`}
          >
            <span>Local vault</span>
            {ctx?.active === 'local' && <span className="text-xs text-primary">active</span>}
          </button>

          {ctx?.roster.map((s) => {
            const isActive = ctx.active !== 'local' && ctx.active.id === s.id;
            return (
              <div key={s.id} className="group flex items-center gap-1">
                <button
                  onClick={() => select(s.id)}
                  disabled={busy}
                  className={`flex flex-1 items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-muted ${
                    isActive ? 'font-medium' : ''
                  }`}
                >
                  <span className="truncate">
                    {s.label}
                    <span className="ml-1 text-xs text-muted-foreground">{s.url}</span>
                  </span>
                  {isActive && <span className="text-xs text-primary">active</span>}
                </button>
                <button
                  onClick={() => remove(s.id)}
                  disabled={busy}
                  className="rounded p-1 text-muted-foreground opacity-0 hover:bg-red-500/10 hover:text-red-500 group-hover:opacity-100"
                  title="Remove"
                  aria-label={`Remove ${s.label}`}
                >
                  ✕
                </button>
              </div>
            );
          })}

          <div className="my-1 border-t border-border" />

          {adding ? (
            <form onSubmit={add} className="space-y-2 p-1">
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://rite.example.com"
                className="w-full rounded border border-input bg-background px-2 py-1 text-sm"
                disabled={busy}
                autoFocus
              />
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Label (optional)"
                className="w-full rounded border border-input bg-background px-2 py-1 text-sm"
                disabled={busy}
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setAdding(false)}
                  className="rounded px-2 py-1 text-xs hover:bg-muted"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy || !url.trim()}
                  className="rounded bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50"
                >
                  Add
                </button>
              </div>
            </form>
          ) : (
            <button
              onClick={() => setAdding(true)}
              className="w-full rounded px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted"
            >
              + Add server…
            </button>
          )}
        </div>
      )}
    </div>
  );
}
