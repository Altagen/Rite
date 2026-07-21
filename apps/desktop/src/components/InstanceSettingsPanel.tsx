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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const mode = await Backend.Server.mode();
      const current = mode.instanceName ?? '';
      setName(current);
      setSaved(current);
    } catch {
      setError('Failed to load instance settings');
    }
  }, []);

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
    </div>
  );
}
