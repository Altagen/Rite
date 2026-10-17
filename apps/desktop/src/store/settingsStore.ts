/**
 * Settings Store — this device's preferences, and where they are kept.
 *
 * Auto-lock, clipboard clearing, keep-alive, host-key policy, default shell.
 *
 * On a LOCAL vault the "server" is this computer, so these live in its settings table
 * like everything else that belongs to the person sitting at it.
 *
 * On a SHARED SERVER that same table is the instance's: one row per key, no owner
 * column. Writing a person's auto-lock there wrote everyone's — and the route that did
 * it accepted any key from any account, which is how host-key verification became
 * something a regular user could switch off for the whole instance (see
 * `settings_route_refusal` in rite-server). So in a server context the preferences that
 * are this device's are kept by this device, in this browser; the ones the server
 * governs are the instance's and are read from `/api/server/mode`, not set here.
 */

import { deviceStore } from '../utils/deviceStore';
import { create } from 'zustand';
import { Backend } from '../utils/backend';
import { useServerSession } from './serverSessionStore';

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

/** Where a browser on a shared server keeps what is its own. */
const DEVICE_STORE_KEY = 'rite.device-settings';

/** Is this a shared server, where the settings table is not this person's? */
const onSharedServer = () => useServerSession.getState().mode?.accounts === true;

function readDeviceSettings(): Settings {
  try {
    const raw = deviceStore.getItem(DEVICE_STORE_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) } : DEFAULT_SETTINGS;
  } catch {
    // Private window, blocked storage, or something else wrote nonsense there.
    return DEFAULT_SETTINGS;
  }
}

function writeDeviceSettings(settings: Settings): void {
  try {
    deviceStore.setItem(DEVICE_STORE_KEY, JSON.stringify(settings));
  } catch {
    // Not persisting is a worse session, not a broken one.
  }
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  // Initial state
  settings: DEFAULT_SETTINGS,
  isLoading: false,
  error: null,

  // Fetch all settings from backend
  fetchSettings: async () => {
    try {
      set({ isLoading: true, error: null });
      if (onSharedServer()) {
        set({ settings: readDeviceSettings(), isLoading: false });
        return;
      }
      const backendSettings = await Backend.Settings.getAllSettings();

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

      if (onSharedServer()) {
        writeDeviceSettings(updated);
        set({ settings: updated, isLoading: false });
        return;
      }

      // Update each setting in backend
      if (newSettings.autoLockEnabled !== undefined) {
        await Backend.Settings.setSetting('auto_lock_enabled', String(newSettings.autoLockEnabled));
      }
      if (newSettings.autoLockTimeout !== undefined) {
        await Backend.Settings.setSetting('auto_lock_timeout', String(newSettings.autoLockTimeout));
      }
      if (newSettings.clipboardClearEnabled !== undefined) {
        await Backend.Settings.setSetting('clipboard_clear_enabled', String(newSettings.clipboardClearEnabled));
      }
      if (newSettings.clipboardClearTimeout !== undefined) {
        await Backend.Settings.setSetting('clipboard_clear_timeout', String(newSettings.clipboardClearTimeout));
      }
      if (newSettings.sshKeepAliveEnabled !== undefined) {
        await Backend.Settings.setSetting('ssh_keep_alive_enabled', String(newSettings.sshKeepAliveEnabled));
      }
      if (newSettings.sshKeepAliveInterval !== undefined) {
        await Backend.Settings.setSetting('ssh_keep_alive_interval', String(newSettings.sshKeepAliveInterval));
      }
      if (newSettings.hostKeyVerificationMode !== undefined) {
        await Backend.Settings.setSetting('host_key_verification_mode', newSettings.hostKeyVerificationMode);
      }
      if (newSettings.defaultShell !== undefined) {
        await Backend.Settings.setSetting('default_shell', newSettings.defaultShell);
      }

      set({ settings: updated, isLoading: false });
    } catch (error) {
      console.error('Failed to update settings:', error);
      set({ error: String(error), isLoading: false });
    }
  },

}));
