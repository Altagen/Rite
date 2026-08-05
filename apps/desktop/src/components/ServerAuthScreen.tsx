/**
 * Server login / first-run admin bootstrap / self-service registration (ADR 0010 + 0015).
 *
 * Shown when the endpoint is a shared server and no session is active. The
 * password is turned into an auth hash client-side (see serverSessionStore) and
 * never sent. When the server has no admin yet it switches to bootstrap mode; when
 * the instance has open registration on, a "Create an account" tab appears.
 */

import { useState } from 'react';
import { useServerSession } from '../store/serverSessionStore';

export function ServerAuthScreen() {
  const { mode, login, bootstrap, register, loading, error, clearError, sessionExpired } =
    useServerSession();
  const isBootstrap = mode?.needsBootstrap === true;
  // Self-registration is offered only when the instance opts in (and not during bootstrap,
  // where the very first account must be the admin).
  const canRegister = !isBootstrap && mode?.openRegistration === true;

  const [tab, setTab] = useState<'signin' | 'register'>('signin');
  const isRegister = canRegister && tab === 'register';
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  const isNewAccount = isBootstrap || isRegister; // generates fresh keys from this password
  const mismatch = isRegister && confirm.length > 0 && confirm !== password;
  const canSubmit =
    username.trim().length > 0 &&
    password.length > 0 &&
    !loading &&
    (!isRegister || confirm === password);

  const switchTab = (next: 'signin' | 'register') => {
    clearError();
    setConfirm('');
    setTab(next);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    clearError();
    try {
      if (isBootstrap) {
        await bootstrap(username.trim(), password);
      } else if (isRegister) {
        await register(username.trim(), password);
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
            {isBootstrap
              ? 'Create the server administrator'
              : isRegister
                ? 'Create your account'
                : 'Sign in to the server'}
          </p>
        </div>

        {sessionExpired && !isNewAccount && (
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
              autoComplete={isNewAccount ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              disabled={loading}
            />
          </div>

          {isRegister && (
            <div className="space-y-2">
              <label htmlFor="confirm" className="text-sm font-medium">
                Confirm password
              </label>
              <input
                id="confirm"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                disabled={loading}
              />
              {mismatch && <p className="text-xs text-red-600">Passwords don&apos;t match.</p>}
            </div>
          )}

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
                : isRegister
                  ? 'Creating account…'
                  : 'Signing in…'
              : isBootstrap
                ? 'Create administrator'
                : isRegister
                  ? 'Create account'
                  : 'Sign in'}
          </button>

          {canRegister && (
            <p className="text-center text-sm text-muted-foreground">
              {isRegister ? (
                <>
                  Already have an account?{' '}
                  <button
                    type="button"
                    onClick={() => switchTab('signin')}
                    className="font-medium text-primary hover:underline"
                  >
                    Sign in
                  </button>
                </>
              ) : (
                <>
                  New here?{' '}
                  <button
                    type="button"
                    onClick={() => switchTab('register')}
                    className="font-medium text-primary hover:underline"
                  >
                    Create an account
                  </button>
                </>
              )}
            </p>
          )}
        </form>

        <p className="text-center text-xs text-muted-foreground">
          The server never sees your password — it is hashed on this device.
        </p>
      </div>
    </div>
  );
}
