/**
 * Unlock Screen
 *
 * Allows the user to unlock the application with their master password
 */

import { useState } from 'react';
import { RevealToggle } from './RevealToggle';
import { Backend } from '../utils/backend';
import { useAuthStore } from '../store/authStore';
import { useTranslation } from '../i18n/i18n';

interface UnlockScreenProps {
  asModal?: boolean;
  onClose?: () => void;
}

export function UnlockScreen({ asModal = false, onClose }: UnlockScreenProps = {}) {
  const { unlock, isLoading, error, rateLimitWaitSeconds, clearError } = useAuthStore();
  const { t } = useTranslation();

  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showResetDialog, setShowResetDialog] = useState(false);
  const [resetConfirmText, setResetConfirmText] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || isLoading || rateLimitWaitSeconds) return;

    clearError();
    const success = await unlock(password);

    if (!success) {
      // Clear password on failure
      setPassword('');
    }
  };

  const handleReset = async () => {
    if (resetConfirmText !== 'DELETE ALL DATA') {
      return;
    }

    try {
      await Backend.Auth.resetDatabase();
      // Reload the page to restart from first run
      window.location.reload();
    } catch (error) {
      console.error('Reset failed:', error);
      alert(t('errors.resetFailed', { error: String(error) }));
    }
  };

  const isRateLimited = rateLimitWaitSeconds !== null && rateLimitWaitSeconds > 0;

  // Modal wrapper for compact desktop UI
  const renderModal = (children: React.ReactNode) => (
    <div className="w-full rounded-lg border border-border bg-card shadow-xl">
      {onClose && (
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 className="text-xl font-bold">{t('unlock.title')}</h2>
          <button onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-muted">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
      )}
      <div className="p-6">{children}</div>
    </div>
  );

  // Full screen wrapper for standalone use
  const renderFullScreen = (children: React.ReactNode) => (
    <div className="flex h-screen items-center justify-center bg-background text-foreground">
      <div className="w-full max-w-md space-y-8 p-8">
        <div className="text-center">
          <h1 className="text-4xl font-bold">{t('unlock.title')}</h1>
          <p className="mt-2 text-muted-foreground">{t('unlock.subtitle')}</p>
        </div>
        {children}
      </div>
    </div>
  );

  const content = (
    <>
      {!asModal && (
        <div className="text-center mb-6">
          <h1 className="text-4xl font-bold">{t('unlock.title')}</h1>
          <p className="mt-2 text-muted-foreground">{t('unlock.subtitle')}</p>
        </div>
      )}

      {/* Reset Dialog */}
      {showResetDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-lg">
            <h2 className="text-xl font-bold text-red-600">{t('unlock.resetTitle')}</h2>
            <p className="mt-4 text-sm">{t('unlock.resetMessage')}</p>
            <p className="mt-2 text-sm text-muted-foreground">{t('unlock.resetWarning')}</p>

            <div className="mt-6 space-y-4">
              <div>
                <label htmlFor="confirmText" className="text-sm font-medium">
                  {t('unlock.resetConfirmLabel')}
                </label>
                <input
                  id="confirmText"
                  type="text"
                  value={resetConfirmText}
                  onChange={(e) => setResetConfirmText(e.target.value)}
                  className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
                  placeholder={t('unlock.resetConfirmPlaceholder')}
                  autoFocus
                />
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => {
                    setShowResetDialog(false);
                    setResetConfirmText('');
                  }}
                  className="flex-1 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-muted"
                >
                  {t('unlock.resetCancel')}
                </button>
                <button
                  onClick={handleReset}
                  disabled={resetConfirmText !== 'DELETE ALL DATA'}
                  className={`flex-1 rounded-md px-4 py-2 text-sm font-medium ${
                    resetConfirmText === 'DELETE ALL DATA'
                      ? 'bg-red-600 text-white hover:bg-red-700'
                      : 'bg-muted text-muted-foreground cursor-not-allowed'
                  }`}
                >
                  {t('unlock.resetSubmit')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <form
        onSubmit={handleSubmit}
        className={`space-y-6 ${asModal ? '' : 'rounded-lg border border-border bg-card p-6'}`}
      >
        {error && (
          <div className="rounded-md bg-red-500/10 border border-red-500/20 p-3">
            {/* The store names the message, this says it: it used to set French prose, so
                  the first screen anyone sees answered in one language whatever was set. */}
            <p className="text-sm text-red-600" data-testid="auth-error">
              {t(error.key, error.params)}
            </p>
          </div>
        )}

        {isRateLimited && (
          <div className="rounded-md bg-yellow-500/10 border border-yellow-500/20 p-3">
            <p className="text-sm text-yellow-600">
              {t('unlock.rateLimited', { seconds: rateLimitWaitSeconds })}
            </p>
          </div>
        )}

        <div className="space-y-2">
          <label htmlFor="password" className="text-sm font-medium">
            {t('unlock.password')}
          </label>
          <div className="relative">
            <input
              id="password"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 pr-10 text-sm"
              placeholder={t('unlock.passwordPlaceholder')}
              disabled={isLoading || isRateLimited}
              autoFocus
            />
            <RevealToggle
              shown={showPassword}
              onToggle={() => setShowPassword((v) => !v)}
              disabled={isLoading || isRateLimited}
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={!password || isLoading || isRateLimited}
          className={`w-full rounded-md px-4 py-2 text-sm font-medium transition-colors ${
            password && !isLoading && !isRateLimited
              ? 'bg-primary text-primary-foreground hover:bg-primary/90'
              : 'bg-muted text-muted-foreground cursor-not-allowed'
          }`}
        >
          {isLoading
            ? t('unlock.submitting')
            : isRateLimited
              ? t('unlock.locked')
              : t('unlock.submit')}
        </button>

        {!asModal && (
          <div className="pt-4 border-t border-border">
            <button
              type="button"
              onClick={() => setShowResetDialog(true)}
              className="w-full text-sm text-muted-foreground hover:text-foreground"
            >
              {t('unlock.forgotPassword')}
            </button>
          </div>
        )}
      </form>

      {!asModal && (
        <p className="text-center text-xs text-muted-foreground">{t('unlock.securityNote')}</p>
      )}
    </>
  );

  return asModal ? renderModal(content) : renderFullScreen(content);
}
