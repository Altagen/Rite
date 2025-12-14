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
import { Tauri } from '../utils/tauri';
import { errorHandler, ErrorSeverity, ErrorCategory } from '../utils/errorHandler';

interface AuthState {
  // State
  isLocked: boolean;
  isFirstRun: boolean | null; // null = not checked yet
  isLoading: boolean;
  error: string | null;
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
      const isFirstRun = await Tauri.Auth.isFirstRun();
      const isLocked = await Tauri.Auth.isLocked();

      set({
        isFirstRun,
        isLocked,
        isLoading: false
      });
    } catch (error) {
      errorHandler.handle('Failed to check first run status', {
        severity: ErrorSeverity.ERROR,
        category: ErrorCategory.AUTH,
        originalError: error,
        context: { store: 'authStore', action: 'checkFirstRun' },
      });
      set({
        error: `Erreur lors de la vérification: ${error}`,
        isLoading: false
      });
    }
  },

  // Setup master password (first run)
  setupMasterPassword: async (password: string, confirmPassword: string) => {
    try {
      set({ isLoading: true, error: null });

      // Validation côté client
      if (password !== confirmPassword) {
        throw new Error('Les mots de passe ne correspondent pas');
      }

      if (password.length < 12) {
        throw new Error('Le mot de passe doit contenir au moins 12 caractères');
      }

      // Call backend
      await Tauri.Auth.setupMasterPassword(password);

      // Success - app is now unlocked
      set({
        isFirstRun: false,
        isLocked: false,
        isLoading: false
      });
    } catch (error) {
      errorHandler.handle('Failed to setup master password', {
        severity: ErrorSeverity.ERROR,
        category: ErrorCategory.AUTH,
        originalError: error,
        context: { store: 'authStore', action: 'setupMasterPassword' },
      });
      set({
        error: `Erreur lors de la création: ${error}`,
        isLoading: false
      });
      throw error;
    }
  },

  // Unlock the application
  unlock: async (password: string): Promise<boolean> => {
    try {
      set({ isLoading: true, error: null, rateLimitWaitSeconds: null });

      const response = await Tauri.Auth.unlock(password);

      if (response.type === 'success') {
        set({
          isLocked: false,
          isLoading: false,
          error: null,
          rateLimitWaitSeconds: null
        });
        return true;
      }

      if (response.type === 'invalidPassword') {
        set({
          error: 'Mot de passe incorrect',
          isLoading: false
        });
        return false;
      }

      if (response.type === 'rateLimited') {
        set({
          error: `Trop de tentatives. Réessayez dans ${response.waitSeconds} secondes.`,
          rateLimitWaitSeconds: response.waitSeconds || 30,
          isLoading: false
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
        error: `Erreur lors du déverrouillage: ${error}`,
        isLoading: false
      });
      return false;
    }
  },

  // Lock the application
  lock: async () => {
    try {
      await Tauri.Auth.lock();
      set({
        isLocked: true,
        error: null
      });
    } catch (error) {
      errorHandler.handle('Application lock failed', {
        severity: ErrorSeverity.WARNING,
        category: ErrorCategory.AUTH,
        originalError: error,
        context: { store: 'authStore', action: 'lock' },
      });
      set({
        error: `Erreur lors du verrouillage: ${error}`
      });
    }
  },

  // Clear error message
  clearError: () => {
    set({ error: null });
  },
}));
