/**
 * Authentication Store
 *
 * Manages the authentication state of the application:
 * - First run detection
 * - Master password setup
 * - Lock/unlock operations
 * - Rate limiting handling
 */

import { create } from 'zustand';
import { Backend } from '../utils/backend';
import { errorHandler, ErrorSeverity, ErrorCategory } from '../utils/errorHandler';

/** The floor the backend also enforces; named once so the message cannot drift from it. */
const MIN_PASSWORD_LENGTH = 12;

/**
 * What went wrong, as a key the screen translates — not as a sentence.
 *
 * This store used to set its own French prose, which the unlock and setup screens render
 * raw: the first screen anyone sees answered in one language whatever the app was set to,
 * and the strings lived outside the locale files where `i18n-check` could not see them.
 * A store cannot call the `t` hook, so it names the message and the screen says it.
 */
export interface AuthErrorMessage {
  key: string;
  params?: Record<string, string | number>;
}

interface AuthState {
  // State
  isLocked: boolean;
  isFirstRun: boolean | null; // null = not checked yet
  isLoading: boolean;
  error: AuthErrorMessage | null;
  rateLimitWaitSeconds: number | null;

  // Actions
  checkFirstRun: () => Promise<void>;
  setupMasterPassword: (password: string, confirmPassword: string) => Promise<void>;
  unlock: (password: string) => Promise<boolean>;
  lock: () => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  // Initial state
  isLocked: true,
  isFirstRun: null,
  isLoading: false,
  error: null,
  rateLimitWaitSeconds: null,

  // Check if this is the first run
  checkFirstRun: async () => {
    try {
      set({ isLoading: true, error: null });
      const isFirstRun = await Backend.Auth.isFirstRun();
      const isLocked = await Backend.Auth.isLocked();

      set({
        isFirstRun,
        isLocked,
        isLoading: false,
      });
    } catch (error) {
      errorHandler.handle('Failed to check first run status', {
        severity: ErrorSeverity.ERROR,
        category: ErrorCategory.AUTH,
        originalError: error,
        context: { store: 'authStore', action: 'checkFirstRun' },
      });
      set({
        error: { key: 'auth.checkFailed', params: { error: String(error) } },
        isLoading: false,
      });
    }
  },

  // Setup master password (first run)
  setupMasterPassword: async (password: string, confirmPassword: string) => {
    try {
      set({ isLoading: true, error: null });

      // Client-side validation. These set the message and stop rather than throwing prose
      // for the catch below to concatenate: the screen needs a key, not a sentence.
      if (password !== confirmPassword) {
        set({ error: { key: 'auth.passwordsDiffer' }, isLoading: false });
        throw new Error('passwords do not match');
      }

      if (password.length < MIN_PASSWORD_LENGTH) {
        set({
          error: { key: 'auth.passwordTooShort', params: { count: MIN_PASSWORD_LENGTH } },
          isLoading: false,
        });
        throw new Error('password too short');
      }

      // Call backend
      await Backend.Auth.setupMasterPassword(password);

      // Success - app is now unlocked
      set({
        isFirstRun: false,
        isLocked: false,
        isLoading: false,
      });
    } catch (error) {
      errorHandler.handle('Failed to setup master password', {
        severity: ErrorSeverity.ERROR,
        category: ErrorCategory.AUTH,
        originalError: error,
        context: { store: 'authStore', action: 'setupMasterPassword' },
      });
      // Keep a validation message the block above already set; only an unexpected
      // failure is described here, or the specific reason is replaced by a generic one.
      if (!get().error) {
        set({ error: { key: 'auth.setupFailed', params: { error: String(error) } } });
      }
      set({ isLoading: false });
      throw error;
    }
  },

  // Unlock the application
  unlock: async (password: string): Promise<boolean> => {
    try {
      set({ isLoading: true, error: null, rateLimitWaitSeconds: null });

      const response = await Backend.Auth.unlock(password);

      if (response.type === 'success') {
        set({
          isLocked: false,
          isLoading: false,
          error: null,
          rateLimitWaitSeconds: null,
        });
        return true;
      }

      if (response.type === 'invalidPassword') {
        set({
          error: { key: 'auth.wrongPassword' },
          isLoading: false,
        });
        return false;
      }

      if (response.type === 'rateLimited') {
        set({
          error: { key: 'unlock.rateLimited', params: { seconds: response.waitSeconds || 30 } },
          rateLimitWaitSeconds: response.waitSeconds || 30,
          isLoading: false,
        });

        // Countdown
        const startCountdown = () => {
          const interval = setInterval(() => {
            const current = get().rateLimitWaitSeconds;
            if (current && current > 0) {
              set({ rateLimitWaitSeconds: current - 1 });
            } else {
              clearInterval(interval);
              set({ rateLimitWaitSeconds: null, error: null });
            }
          }, 1000);
        };
        startCountdown();

        return false;
      }

      return false;
    } catch (error) {
      errorHandler.handle('Application unlock failed', {
        severity: ErrorSeverity.ERROR,
        category: ErrorCategory.AUTH,
        originalError: error,
        context: { store: 'authStore', action: 'unlock' },
      });
      set({
        error: { key: 'auth.unlockFailed', params: { error: String(error) } },
        isLoading: false,
      });
      return false;
    }
  },

  // Lock the application
  lock: async () => {
    try {
      await Backend.Auth.lock();
      set({
        isLocked: true,
        error: null,
      });
    } catch (error) {
      errorHandler.handle('Application lock failed', {
        severity: ErrorSeverity.WARNING,
        category: ErrorCategory.AUTH,
        originalError: error,
        context: { store: 'authStore', action: 'lock' },
      });
      set({
        error: { key: 'auth.lockFailed', params: { error: String(error) } },
      });
    }
  },

  // Clear error message
  clearError: () => {
    set({ error: null });
  },
}));
