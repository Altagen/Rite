/**
 * Setup Screen - First run experience
 *
 * Allows the user to create their master password
 */

import { useState, useEffect } from 'react';
import { RevealToggle } from './RevealToggle';
import { Backend, type PasswordStrength } from '../utils/backend';
import { useAuthStore } from '../store/authStore';
import { useTranslation } from '../i18n/i18n';

interface SetupScreenProps {
  asModal?: boolean;
  onClose?: () => void;
}

export function SetupScreen({ asModal = false, onClose }: SetupScreenProps = {}) {
  const { setupMasterPassword, isLoading, error, clearError } = useAuthStore();
  const { t } = useTranslation();

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [strength, setStrength] = useState<PasswordStrength | null>(null);

  // Real-time password validation
  useEffect(() => {
    const validatePassword = async () => {
      if (!password) {
        setStrength(null);
        return;
      }

      try {
        const result = await Backend.Auth.validatePassword(password);
        setStrength(result);
      } catch (error) {
        console.error('Failed to validate password:', error);
      }
    };

    const timer = setTimeout(() => {
      validatePassword();
    }, 300);

    return () => clearTimeout(timer);
  }, [password]);

  // Length-first strength (NIST 800-63B): 12 chars is the *floor*, not "excellent". Tiers go by
  // length so a barely-12 password reads as minimal (orange), and only long ones read as strong.
  // `score` (char variety) only demotes a long-but-low-variety password, never promotes a short one.
  const getStrength = (pw: string, valid: boolean, score: number) => {
    const len = pw.length;
    if (!valid)
      return {
        label: t('setup.strengthWeak'),
        bar: 'bg-red-500',
        text: 'text-red-600',
        pct: Math.max(8, Math.min(len / 12, 1) * 30),
      };
    if (len >= 20 && score >= 5)
      return {
        label: t('setup.strengthExcellent'),
        bar: 'bg-green-500',
        text: 'text-green-600',
        pct: 100,
      };
    if (len >= 16 && score >= 4)
      return {
        label: t('setup.strengthGood'),
        bar: 'bg-yellow-500',
        text: 'text-yellow-600',
        pct: 74,
      };
    return {
      label: t('setup.strengthFair'),
      bar: 'bg-orange-500',
      text: 'text-orange-600',
      pct: 48,
    };
  };

  const passwordsMatch = password && confirmPassword && password === confirmPassword;
  const canSubmit = strength?.is_valid && passwordsMatch && !isLoading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    clearError();
    try {
      await setupMasterPassword(password, confirmPassword);
      // Success - the store will update and trigger re-render.
      onClose?.();
    } catch (error) {
      // Error is already set in the store
      console.error('Setup failed:', error);
    }
  };

  const content = (
    <div className="relative w-full max-w-md space-y-8 p-8">
      {asModal && onClose && (
        <button
          type="button"
          onClick={onClose}
          disabled={isLoading}
          aria-label={t('common.close')}
          title={t('common.close')}
          className="absolute right-3 top-3 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          <svg
            className="h-5 w-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
      <div className="text-center">
        <h1 className="text-4xl font-bold">{t('setup.title')}</h1>
        <p className="mt-2 text-muted-foreground">{t('setup.subtitle')}</p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="space-y-6 rounded-lg border border-border bg-card p-6"
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

        <div className="space-y-4">
          {/* Password field */}
          <div className="space-y-2">
            <label htmlFor="password" className="text-sm font-medium">
              {t('setup.password')}
            </label>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 pr-10 text-sm"
                placeholder={t('setup.passwordPlaceholder')}
                disabled={isLoading}
                autoFocus
              />
              <RevealToggle shown={showPassword} onToggle={() => setShowPassword((v) => !v)} />
            </div>

            {/* Password strength bar (length-first) */}
            {password &&
              strength &&
              (() => {
                const s = getStrength(password, strength.is_valid, strength.score);
                return (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">{t('setup.passwordStrength')}</span>
                      <span className={`font-medium ${s.text}`}>{s.label}</span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className={`h-full transition-all duration-300 ${s.bar}`}
                        style={{ width: `${s.pct}%` }}
                      />
                    </div>
                    {strength.is_valid && password.length < 16 && (
                      <p className="text-[11px] text-muted-foreground">{t('setup.aim16')}</p>
                    )}
                  </div>
                );
              })()}
          </div>

          {/* Confirm password field */}
          <div className="space-y-2">
            <label htmlFor="confirmPassword" className="text-sm font-medium">
              {t('setup.confirmPassword')}
            </label>
            <div className="relative">
              <input
                id="confirmPassword"
                type={showConfirmPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className={`w-full rounded-md border px-3 py-2 pr-10 text-sm ${
                  confirmPassword && !passwordsMatch
                    ? 'border-red-500 bg-background'
                    : 'border-input bg-background'
                }`}
                placeholder={t('setup.confirmPasswordPlaceholder')}
                disabled={isLoading}
              />
              <RevealToggle
                shown={showConfirmPassword}
                onToggle={() => setShowConfirmPassword((v) => !v)}
              />
            </div>
            {confirmPassword && !passwordsMatch && (
              <p className="text-xs text-red-500">{t('setup.passwordsMismatch')}</p>
            )}
            {passwordsMatch && (
              <p className="text-xs text-green-600">{t('setup.passwordsMatch')}</p>
            )}
          </div>

          {/* Feedback */}
          {strength && strength.feedback.length > 0 && (
            <div className="space-y-2 rounded-md bg-muted p-3">
              <p className="text-xs font-medium">{t('setup.suggestions')}</p>
              <ul className="list-inside list-disc space-y-1 text-xs text-muted-foreground">
                {strength.feedback.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <button
          type="submit"
          disabled={!canSubmit}
          className={`w-full rounded-md px-4 py-2 text-sm font-medium transition-colors ${
            canSubmit
              ? 'bg-primary text-primary-foreground hover:bg-primary/90'
              : 'bg-muted text-muted-foreground cursor-not-allowed'
          }`}
        >
          {isLoading ? t('setup.submitting') : t('setup.submit')}
        </button>
      </form>

      <p className="text-center text-xs text-muted-foreground">{t('setup.warning')}</p>
    </div>
  );

  if (asModal) return content;
  return (
    <div className="flex h-screen items-center justify-center bg-background text-foreground">
      {content}
    </div>
  );
}
