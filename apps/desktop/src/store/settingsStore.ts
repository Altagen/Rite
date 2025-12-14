/**
 * Settings Store
 *
 * Manages application settings:
 * - Auto-lock settings
 * - Clipboard security
 * - Other preferences
 */

import { create } from 'zustand';
import { Tauri } from '../utils/tauri';

export interface Settings {
  autoLockEnabled: boolean;
  autoLockTimeout: number; // in minutes, 0 = disabled
  clipboardClearEnabled: boolean;
  clipboardClearTimeout: number; // in seconds
  sshKeepAliveEnabled: boolean;
  sshKeepAliveInterval: number; // in seconds, 0 = disabled
  hostKeyVerificationMode: 'strict' | 'warn' | 'accept'; // SSH host key verification mode
  defaultShell: string; // Default shell for local terminals
}

interface SettingsState {
  // State
  settings: Settings;
  isLoading: boolean;
  error: string | null;

  // Actions
  fetchSettings: () => Promise<void>;
  updateSettings: (settings: Partial<Settings>) => Promise<void>;
  getSetting: (key: string) => Promise<string | null>;
  setSetting: (key: string, value: string) => Promise<void>;
}

const DEFAULT_SETTINGS: Settings = {
  autoLockEnabled: false,
  autoLockTimeout: 0,
  clipboardClearEnabled: false,
  clipboardClearTimeout: 30,
  sshKeepAliveEnabled: false,
  sshKeepAliveInterval: 30,
  hostKeyVerificationMode: 'strict',
  defaultShell: '/usr/bin/bash', // Bash is universally available
};

export const useSettingsStore = create<SettingsState>((set, get) => ({
  // Initial state
  settings: DEFAULT_SETTINGS,
  isLoading: false,
  error: null,

  // Fetch all settings from backend
  fetchSettings: async () => {
    try {
      set({ isLoading: true, error: null });
      const backendSettings = await Tauri.Settings.getAllSettings();

      const settings: Settings = {
        autoLockEnabled: backendSettings.auto_lock_enabled === 'true',
        autoLockTimeout: parseInt(backendSettings.auto_lock_timeout || '0', 10),
        clipboardClearEnabled: backendSettings.clipboard_clear_enabled === 'true',
        clipboardClearTimeout: parseInt(backendSettings.clipboard_clear_timeout || '30', 10),
        sshKeepAliveEnabled: backendSettings.ssh_keep_alive_enabled === 'true',
        sshKeepAliveInterval: parseInt(backendSettings.ssh_keep_alive_interval || '30', 10),
        hostKeyVerificationMode: (backendSettings.host_key_verification_mode || 'strict') as 'strict' | 'warn' | 'accept',
        defaultShell: backendSettings.default_shell || '/usr/bin/bash',
      };

      set({ settings, isLoading: false });
    } catch (error) {
      console.error('Failed to fetch settings:', error);
      set({ error: String(error), isLoading: false });
    }
  },

  // Update multiple settings at once
  updateSettings: async (newSettings: Partial<Settings>) => {
    try {
      set({ isLoading: true, error: null });

      const { settings } = get();
      const updated = { ...settings, ...newSettings };

      // Update each setting in backend
      if (newSettings.autoLockEnabled !== undefined) {
        await Tauri.Settings.setSetting('auto_lock_enabled', String(newSettings.autoLockEnabled));
      }
      if (newSettings.autoLockTimeout !== undefined) {
        await Tauri.Settings.setSetting('auto_lock_timeout', String(newSettings.autoLockTimeout));
      }
      if (newSettings.clipboardClearEnabled !== undefined) {
        await Tauri.Settings.setSetting('clipboard_clear_enabled', String(newSettings.clipboardClearEnabled));
      }
      if (newSettings.clipboardClearTimeout !== undefined) {
        await Tauri.Settings.setSetting('clipboard_clear_timeout', String(newSettings.clipboardClearTimeout));
      }
      if (newSettings.sshKeepAliveEnabled !== undefined) {
        await Tauri.Settings.setSetting('ssh_keep_alive_enabled', String(newSettings.sshKeepAliveEnabled));
      }
      if (newSettings.sshKeepAliveInterval !== undefined) {
        await Tauri.Settings.setSetting('ssh_keep_alive_interval', String(newSettings.sshKeepAliveInterval));
      }
      if (newSettings.hostKeyVerificationMode !== undefined) {
        await Tauri.Settings.setSetting('host_key_verification_mode', newSettings.hostKeyVerificationMode);
      }
      if (newSettings.defaultShell !== undefined) {
        await Tauri.Settings.setSetting('default_shell', newSettings.defaultShell);
      }

      set({ settings: updated, isLoading: false });
    } catch (error) {
      console.error('Failed to update settings:', error);
      set({ error: String(error), isLoading: false });
    }
  },

  // Get a single setting
  getSetting: async (key: string) => {
    try {
      const value = await Tauri.Settings.getSetting(key);
      return value;
    } catch (error) {
      console.error(`Failed to get setting ${key}:`, error);
      return null;
    }
  },

  // Set a single setting
  setSetting: async (key: string, value: string) => {
    try {
      await Tauri.Settings.setSetting(key, value);
    } catch (error) {
      console.error(`Failed to set setting ${key}:`, error);
      throw error;
    }
  },
}));
