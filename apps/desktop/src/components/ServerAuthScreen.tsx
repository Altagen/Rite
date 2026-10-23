/**
 * Server login / first-run admin bootstrap / self-service registration (ADR 0010 + 0015).
 *
 * Shown when the endpoint is a shared server and no session is active. The password is turned into
 * an auth hash client-side (see serverSessionStore) and never sent. When the server has no admin yet
 * it switches to bootstrap mode, where the name is fixed to `admin` and only the password is
 * chosen (utils/adminUsername.ts); otherwise a "Create an account" entry appears when open registration
 * is on, and a "Redeem an invitation token" entry is always available (a token works even when open
 * registration is off — it carries a role/team recipe, never a key).
 */

import { useState } from 'react';
import { ADMIN_USERNAME } from '../utils/adminUsername';
import { isNativeShell, requestSwitchContext } from '../utils/nativeShell';
import { RevealToggle } from './RevealToggle';
import { useTranslation } from '../i18n/i18n';
import { useServerSession } from '../store/serverSessionStore';

export function ServerAuthScreen() {
  const { t } = useTranslation();
  const { mode, login, bootstrap, register, loading, error, clearError, sessionExpired } =
    useServerSession();
  const isBootstrap = mode?.needsBootstrap === true;
  const openReg = mode?.openRegistration === true;

  const [tab, setTab] = useState<'signin' | 'register'>('signin');
  const isRegister = !isBootstrap && tab === 'register';
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  // One eye for both fields: on the register tab they must match, so revealing one and
  // not the other is how you stare at two dots and still cannot tell.
  const [reveal, setReveal] = useState(false);
  const [token, setToken] = useState('');

  // On the bootstrap screen the name is not a field: it is `admin`, shown and locked
  // (see utils/adminUsername.ts). Only the password is chosen here.
  const effectiveUsername = isBootstrap ? ADMIN_USERNAME : username.trim();

  const isNewAccount = isBootstrap || isRegister; // generates fresh keys from this password
  const mismatch = isRegister && confirm.length > 0 && confirm !== password;
  // With open registration off, an account can only be created here by redeeming a token.
  const tokenRequired = isRegister && !openReg;
  const canSubmit =
    effectiveUsername.length > 0 &&
    password.length > 0 &&
    !loading &&
    (!isRegister || confirm === password) &&
    (!tokenRequired || token.trim().length > 0);

  const switchTab = (next: 'signin' | 'register') => {
    clearError();
    setConfirm('');
    setToken('');
    setTab(next);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    clearError();
    try {
      if (isBootstrap) {
        await bootstrap(effectiveUsername, password);
      } else if (isRegister) {
        await register(effectiveUsername, password, token.trim() || undefined);
      } else {
        await login(effectiveUsername, password);
      }
    } catch {
      // error is surfaced via the store
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-background text-foreground">
      <div className="w-full max-w-md space-y-8 p-8">
        {/* The way out, on the desktop only.
            A server window is dedicated to its context (ADR 0006/0014), so this screen had
            no chrome at all and nothing to leave by: clicking the wrong server left the
            person at a sign-in form for an account they may not have, with only the window
            manager as an exit. Switching back to the local vault is the honest way out —
            the base vault always exists (base-first, ADR 0014) and its context pill offers
            every other server. In a browser there is nothing to switch to, so nothing shows. */}
        {isNativeShell() && (
          <button
            type="button"
            data-testid="auth-back-to-local"
            onClick={() => requestSwitchContext({ kind: 'local' })}
            title={t('auth.backToLocalWhy')}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <svg
              className="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 18l-6-6 6-6" />
            </svg>
            {t('auth.backToLocal')}
          </button>
        )}
        <div className="text-center">
          <h1 className="text-4xl font-bold">Rite</h1>
          {mode?.instanceName && (
            <p className="mt-1 text-lg font-medium text-primary">{mode.instanceName}</p>
          )}
          <p className="mt-2 text-muted-foreground">
            {isBootstrap
              ? t('auth.createAdminTitle')
              : isRegister
                ? t('auth.createAccountTitle')
                : t('auth.signInTitle')}
          </p>
        </div>

        {sessionExpired && !isNewAccount && (
          <div className="rounded-md border border-primary/25 bg-primary/[0.08] p-3 text-sm text-foreground/80">
            <b>{t('auth.expired')}</b> {t('auth.expiredWhy')}
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
              {t('auth.username')}
            </label>
            <input
              id="username"
              type="text"
              autoComplete="username"
              value={isBootstrap ? ADMIN_USERNAME : username}
              onChange={(e) => setUsername(e.target.value)}
              readOnly={isBootstrap}
              aria-readonly={isBootstrap || undefined}
              className={`w-full rounded-md border border-input px-3 py-2 text-sm ${
                isBootstrap ? 'bg-muted text-muted-foreground' : 'bg-background'
              }`}
              disabled={loading}
              autoFocus={!isBootstrap}
            />
            {isBootstrap && (
              <p className="text-xs text-muted-foreground">{t('auth.adminNameFixed')}</p>
            )}
          </div>

          <div className="space-y-2">
            <label htmlFor="password" className="text-sm font-medium">
              {t('auth.password')}
            </label>
            <div className="relative">
              <input
                id="password"
                type={reveal ? 'text' : 'password'}
                autoComplete={isNewAccount ? 'new-password' : 'current-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 pr-10 text-sm"
                disabled={loading}
                autoFocus={isBootstrap}
              />
              <RevealToggle
                shown={reveal}
                onToggle={() => setReveal((v) => !v)}
                disabled={loading}
              />
            </div>
          </div>

          {isRegister && (
            <div className="space-y-2">
              <label htmlFor="confirm" className="text-sm font-medium">
                {t('auth.confirmPassword')}
              </label>
              <div className="relative">
                <input
                  id="confirm"
                  type={reveal ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 pr-10 text-sm"
                  disabled={loading}
                />
                <RevealToggle
                  shown={reveal}
                  onToggle={() => setReveal((v) => !v)}
                  disabled={loading}
                />
              </div>
              {mismatch && <p className="text-xs text-red-600">{t('auth.pwNoMatch')}</p>}
            </div>
          )}

          {isRegister && (
            <div className="space-y-2">
              <label htmlFor="token" className="text-sm font-medium">
                {t('auth.tokenLabel')}{' '}
                <span className="font-normal text-muted-foreground">
                  {tokenRequired ? t('auth.tokenRequired') : t('auth.tokenOptional')}
                </span>
              </label>
              <input
                id="token"
                type="text"
                autoComplete="off"
                placeholder="rite_…"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                disabled={loading}
              />
              <p className="text-xs text-muted-foreground">
                {tokenRequired ? t('auth.inviteOnly') : t('auth.haveInvite')}
              </p>
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
                ? t('auth.creatingAdmin')
                : isRegister
                  ? t('auth.creating')
                  : t('auth.signingIn')
              : isBootstrap
                ? t('auth.createAdmin')
                : isRegister
                  ? t('auth.create')
                  : t('auth.signIn')}
          </button>

          {!isBootstrap && (
            <p className="text-center text-sm text-muted-foreground">
              {isRegister ? (
                <>
                  {t('auth.haveAccount')}{' '}
                  <button
                    type="button"
                    onClick={() => switchTab('signin')}
                    className="font-medium text-primary hover:underline"
                  >
                    {t('auth.signIn')}
                  </button>
                </>
              ) : (
                <>
                  {openReg && (
                    <>
                      {t('auth.newHere')}{' '}
                      <button
                        type="button"
                        onClick={() => switchTab('register')}
                        className="font-medium text-primary hover:underline"
                      >
                        {t('auth.createAccount')}
                      </button>
                      {' · '}
                    </>
                  )}
                  {t('auth.haveToken')}{' '}
                  <button
                    type="button"
                    onClick={() => switchTab('register')}
                    className="font-medium text-primary hover:underline"
                  >
                    {t('auth.redeem')}
                  </button>
                </>
              )}
            </p>
          )}
        </form>

        <p className="text-center text-xs text-muted-foreground">{t('auth.neverSees')}</p>
      </div>
    </div>
  );
}
