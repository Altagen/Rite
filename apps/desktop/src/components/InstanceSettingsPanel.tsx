/**
 * Instance settings (org-admin): a global name for this Rite server so users can
 * tell which instance they're on (the browser has no context pill). Stored
 * server-side as a setting and surfaced publicly on the login screen + header.
 */

import { useCallback, useEffect, useState } from 'react';
import { Backend } from '../utils/backend';

export function InstanceSettingsPanel() {
  const [name, setName] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const [persistence, setPersistence] = useState(true);
  const [shell, setShell] = useState('bash');
  const [quickSsh, setQuickSsh] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const mode = await Backend.Server.mode();
      const current = mode.instanceName ?? '';
      setName(current);
      setSaved(current);
      setPersistence(mode.sessionPersistence !== false);
      setShell(mode.defaultShell ?? 'bash');
      setQuickSsh(mode.allowQuickSsh === true);
    } catch {
      setError('Failed to load instance settings');
    }
  }, []);

  const changeShell = async (next: string) => {
    const prev = shell;
    setShell(next);
    try {
      await Backend.Admin.setDefaultShell(next);
    } catch (err) {
      setShell(prev);
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  const toggleQuickSsh = async () => {
    const next = !quickSsh;
    setQuickSsh(next);
    try {
      await Backend.Admin.setQuickSsh(next);
    } catch (err) {
      setQuickSsh(!next);
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  const togglePersistence = async () => {
    const next = !persistence;
    setPersistence(next);
    try {
      await Backend.Admin.setSessionPersistence(next);
    } catch (err) {
      setPersistence(!next); // revert on failure
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async initial load
    load();
  }, [load]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await Backend.Admin.setInstanceName(name.trim());
      setSaved(name.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-2xl space-y-5">
      <div>
        <h2 className="text-xl font-semibold">Instance</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          A global name for this server (e.g. your company or team). Shown to everyone on the sign-in screen and in the
          header, so users can tell instances apart.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-600">{error}</div>
      )}

      <form onSubmit={save} className="flex items-end gap-3 rounded-lg border border-border bg-card p-4">
        <div className="flex-1 space-y-1">
          <label htmlFor="instance-name" className="text-xs font-medium text-muted-foreground">
            Instance name
          </label>
          <input
            id="instance-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Acme Corp"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            disabled={busy}
          />
        </div>
        <button
          type="submit"
          disabled={busy || name.trim() === (saved ?? '')}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          Save
        </button>
      </form>

      {saved !== null && saved === name.trim() && (
        <p className="text-xs text-muted-foreground">
          Saved. It appears for everyone after their next page load.
        </p>
      )}

      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="font-medium">Keep users signed in across reloads</div>
            <p className="mt-1 text-sm text-muted-foreground">
              Stores each user's vault key in their browser's session storage so a page reload doesn't force a
              re-login. Still zero-knowledge — the key never leaves the browser and is cleared when the tab closes.
              Turn this off to enforce a RAM-only key (re-login on every reload).
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={persistence}
            onClick={togglePersistence}
            className={`relative h-6 w-11 flex-none rounded-full transition-colors ${
              persistence ? 'bg-primary' : 'bg-muted'
            }`}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                persistence ? 'translate-x-5' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>
      </div>

      {/* Client capabilities — what connected clients may do, governed here. */}
      <div className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <div className="text-base font-semibold">Client capabilities</div>
          <p className="mt-0.5 text-xs text-muted-foreground">What connected clients may do on this server.</p>
        </div>

        <div className="flex items-start justify-between gap-4 border-b border-border p-4">
          <div>
            <div className="font-medium">Default shell</div>
            <p className="mt-1 text-sm text-muted-foreground">
              The shell for terminals opened on this server. Web-UI users don&apos;t pick their own — this is it.
              (Desktop users choose their own <b>local</b> shell.)
            </p>
          </div>
          <select
            value={shell}
            onChange={(e) => changeShell(e.target.value)}
            className="flex-none rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {['bash', 'sh', 'zsh', 'fish'].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-start justify-between gap-4 p-4">
          <div>
            <div className="font-medium">Allow Quick SSH</div>
            <p className="mt-1 text-sm text-muted-foreground">
              Ad-hoc one-off SSH from the toolbar. <b>Off by default</b> — connections on a server should live in{' '}
              <b>collections</b> (saved, shared, auditable). Turn on for teams that need quick throwaway sessions.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={quickSsh}
            onClick={toggleQuickSsh}
            className={`relative h-6 w-11 flex-none rounded-full transition-colors ${quickSsh ? 'bg-primary' : 'bg-muted'}`}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
                quickSsh ? 'translate-x-5' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>
      </div>
    </div>
  );
}
