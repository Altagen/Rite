/**
 * Server login / first-run admin bootstrap (ADR 0010).
 *
 * Shown when the endpoint is a shared server and no session is active. The
 * password is turned into an auth hash client-side (see serverSessionStore) and
 * never sent. When the server has no admin yet it switches to bootstrap mode.
 */

import { useState } from 'react';
import { useServerSession } from '../store/serverSessionStore';

export function ServerAuthScreen() {
  const { mode, login, bootstrap, loading, error, clearError, sessionExpired } = useServerSession();
  const isBootstrap = mode?.needsBootstrap === true;

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const canSubmit = username.trim().length > 0 && password.length > 0 && !loading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    clearError();
    try {
      if (isBootstrap) {
        await bootstrap(username.trim(), password);
      } else {
        await login(username.trim(), password);
      }
    } catch {
      // error is surfaced via the store
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-background text-foreground">
      <div className="w-full max-w-md space-y-8 p-8">
        <div className="text-center">
          <h1 className="text-4xl font-bold">Rite</h1>
          {mode?.instanceName && (
            <p className="mt-1 text-lg font-medium text-primary">{mode.instanceName}</p>
          )}
          <p className="mt-2 text-muted-foreground">
            {isBootstrap ? 'Create the server administrator' : 'Sign in to the server'}
          </p>
        </div>

        {sessionExpired && !isBootstrap && (
          <div className="rounded-md border border-primary/25 bg-primary/[0.08] p-3 text-sm text-foreground/80">
            <b>Your session expired.</b> For your security you were signed out — sign in again to carry on. Your saved
            connections stay safe and encrypted.
          </div>
        )}

        <form
          onSubmit={handleSubmit}
          className="space-y-6 rounded-lg border border-border bg-card p-6"
        >
          {error && (
            <div className="rounded-md border border-red-500/20 bg-red-500/10 p-3">
              <p className="text-sm text-red-600">{error}</p>
            </div>
          )}

          <div className="space-y-2">
            <label htmlFor="username" className="text-sm font-medium">
              Username
            </label>
            <input
              id="username"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              disabled={loading}
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="password" className="text-sm font-medium">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete={isBootstrap ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              disabled={loading}
            />
          </div>

          <button
            type="submit"
            disabled={!canSubmit}
            className={`w-full rounded-md px-4 py-2 text-sm font-medium transition-colors ${
              canSubmit
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'cursor-not-allowed bg-muted text-muted-foreground'
            }`}
          >
            {loading
              ? isBootstrap
                ? 'Creating…'
                : 'Signing in…'
              : isBootstrap
                ? 'Create administrator'
                : 'Sign in'}
          </button>
        </form>

        <p className="text-center text-xs text-muted-foreground">
          The server never sees your password — it is hashed on this device.
        </p>
      </div>
    </div>
  );
}
