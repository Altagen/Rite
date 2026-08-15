/**
 * Quick SSH Connect Modal
 *
 * For ad-hoc SSH connections without saving credentials permanently
 * No unlock required - credentials stay in memory only
 */

import { useState } from 'react';
import { Backend } from '../utils/backend';
import { type CreateConnectionInput, type AuthType } from '../store/connectionsStore';
import { AuthSection } from './AuthSection';
import { makeAuthState, toAuthMethodInput, type AuthState } from '../utils/authMethod';

interface QuickSSHModalProps {
  onClose: () => void;
  onConnected: (sessionId: string, connectionInfo: QuickSSHConnectionInfo) => void;
  // ADR 0016: shared collections the caller may save into. When present, the
  // modal offers "save to collection" so a one-off connect can be kept.
  collectionTargets?: { id: string; name: string }[];
  onSaveToCollection?: (input: CreateConnectionInput) => Promise<void>;
}

export interface QuickSSHConnectionInfo {
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  password?: string;
  keyPath?: string;
  passphrase?: string;
}

export function QuickSSHModal({ onClose, onConnected, collectionTargets, onSaveToCollection }: QuickSSHModalProps) {
  const [host, setHost] = useState('');
  const [port, setPort] = useState(22);
  const [username, setUsername] = useState('');
  const [auth, setAuth] = useState<AuthState>(makeAuthState());
  const [saveCollectionId, setSaveCollectionId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      // Build auth method for quick_ssh_connect (shared shape with the form)
      const authMethod = toAuthMethodInput(auth);

      console.log('[QuickSSH] Connecting via quick_ssh_connect...');
      const sessionId = await Backend.Terminal.quickSshConnect(
        host,
        username,
        port,
        authMethod
      );

      console.log('[QuickSSH] Connected successfully, session:', sessionId);

      // Pass connection info back for potential saving
      const connectionInfo: QuickSSHConnectionInfo = {
        host,
        port,
        username,
        authType: auth.authType,
        password: auth.authType === 'password' ? auth.password : undefined,
        keyPath: auth.authType === 'publicKey' ? auth.keyPath : undefined,
        passphrase: auth.authType === 'publicKey' && auth.passphrase ? auth.passphrase : undefined,
      };

      // Optionally persist this one-off into a shared collection (ADR 0016). Saving
      // is best-effort — the session is already up; a save failure doesn't unwind it.
      if (saveCollectionId && onSaveToCollection) {
        try {
          await onSaveToCollection({
            name: `${username}@${host}`,
            protocol: 'SSH',
            hostname: host,
            port,
            username,
            authMethod,
            collectionId: saveCollectionId,
          });
        } catch (saveErr) {
          console.error('[QuickSSH] Saved connection failed (session still open):', saveErr);
        }
      }

      onConnected(sessionId, connectionInfo);
      onClose();
    } catch (err) {
      console.error('[QuickSSH] Connection failed:', err);
      setError(err as string);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="mx-4 w-full max-w-md rounded-lg bg-background p-6 shadow-xl border border-border">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-bold flex items-center gap-2">
            <span className="text-2xl">⚡</span>
            Quick SSH Connect
          </h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-muted"
            disabled={loading}
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <p className="mb-4 text-sm text-muted-foreground">
          Connect to SSH server without saving credentials
        </p>

        {error && (
          <div className="mb-4 rounded border border-red-500 bg-red-500/10 p-3 text-sm text-red-500">
            {error}
          </div>
        )}

        <form onSubmit={handleConnect} className="space-y-4">
          {/* Host */}
          <div>
            <label className="mb-1 block text-sm font-medium">
              Host <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="example.com"
              className="w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              required
              disabled={loading}
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            {/* Port */}
            <div className="col-span-1">
              <label className="mb-1 block text-sm font-medium">
                Port
              </label>
              <input
                type="number"
                value={port}
                onChange={(e) => setPort(Number(e.target.value))}
                className="w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                required
                min={1}
                max={65535}
                disabled={loading}
              />
            </div>

            {/* Username */}
            <div className="col-span-2">
              <label className="mb-1 block text-sm font-medium">
                Username <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="user"
                className="w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                required
                disabled={loading}
              />
            </div>
          </div>

          {/* Authentication — shared with the connection form (password / key / agent) */}
          <AuthSection value={auth} onChange={setAuth} />

          {/* Save to collection (ADR 0016) — optional */}
          {collectionTargets && collectionTargets.length > 0 && (
            <div>
              <label className="mb-1 block text-sm font-medium">Save to collection (optional)</label>
              <select
                value={saveCollectionId}
                onChange={(e) => setSaveCollectionId(e.target.value)}
                className="w-full rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                disabled={loading}
              >
                <option value="">Don't save — connect once</option>
                {collectionTargets.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded bg-secondary px-4 py-2 font-medium text-secondary-foreground hover:bg-secondary/80"
              disabled={loading}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded bg-primary px-4 py-2 font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 flex items-center gap-2"
              disabled={loading || !host || !username || (auth.authType === 'password' && !auth.password) || (auth.authType === 'publicKey' && !auth.keyPath)}
            >
              {loading && (
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-solid border-current border-r-transparent" />
              )}
              {loading ? 'Connecting...' : 'Connect'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
