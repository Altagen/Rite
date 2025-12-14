/**
 * Setup Screen - First run experience
 *
 * Allows the user to create their master password
 */

import { useState, useEffect } from 'react';
import { Tauri, type PasswordStrength } from '../utils/tauri';
import { useAuthStore } from '../store/authStore';
import { useTranslation } from '../i18n/i18n';

export function SetupScreen() {
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
        const result = await Tauri.Auth.validatePassword(password);
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

  const getStrengthColor = (score: number): string => {
    if (score <= 2) return 'bg-red-500';
    if (score <= 4) return 'bg-orange-500';
    if (score <= 5) return 'bg-yellow-500';
    return 'bg-green-500';
  };

  const getStrengthLabel = (score: number): string => {
    if (score <= 2) return t('setup.strengthWeak');
    if (score <= 4) return t('setup.strengthFair');
    if (score <= 5) return t('setup.strengthGood');
    return t('setup.strengthExcellent');
  };

  const passwordsMatch = password && confirmPassword && password === confirmPassword;
  const canSubmit = strength?.is_valid && passwordsMatch && !isLoading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    clearError();
    try {
      await setupMasterPassword(password, confirmPassword);
      // Success - the store will update and trigger re-render
    } catch (error) {
      // Error is already set in the store
      console.error('Setup failed:', error);
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-background text-foreground">
      <div className="w-full max-w-md space-y-8 p-8">
        <div className="text-center">
          <h1 className="text-4xl font-bold">{t('setup.title')}</h1>
          <p className="mt-2 text-muted-foreground">
            {t('setup.subtitle')}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6 rounded-lg border border-border bg-card p-6">
          {error && (
            <div className="rounded-md bg-red-500/10 border border-red-500/20 p-3">
              <p className="text-sm text-red-600">{error}</p>
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
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label={showPassword ? t('setup.hidePassword') : t('setup.showPassword')}
                  tabIndex={-1}
                >
                  {showPassword ? (
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="h-5 w-5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />
                    </svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="h-5 w-5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                  )}
                </button>
              </div>

              {/* Password strength bar */}
              {password && strength && (
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">{t('setup.passwordStrength')}</span>
                    <span className={`font-medium ${strength.is_valid ? 'text-green-600' : 'text-red-600'}`}>
                      {getStrengthLabel(strength.score)}
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className={`h-full transition-all duration-300 ${getStrengthColor(strength.score)}`}
                      style={{ width: `${(strength.score / 7) * 100}%` }}
                    />
                  </div>
                </div>
              )}
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
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label={showConfirmPassword ? t('setup.hidePassword') : t('setup.showPassword')}
                  tabIndex={-1}
                >
                  {showConfirmPassword ? (
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="h-5 w-5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />
                    </svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="h-5 w-5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                  )}
                </button>
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

        <p className="text-center text-xs text-muted-foreground">
          {t('setup.warning')}
        </p>
      </div>
    </div>
  );
}
