/**
 * Auto-reconnect preference for dropped SSH sessions.
 *
 * OFF by default: reconnecting opens a *new* shell — the previous history,
 * on-screen output and any running job are lost — so we never force it. When
 * on, a dropped session reconnects automatically (and the pane says so); when
 * off, the pane shows a Reconnect button instead. Either way the user is told
 * they were disconnected. A per-device UI choice, persisted in localStorage.
 */
import { create } from 'zustand';

const KEY = 'rite-auto-reconnect';
const readPref = (): boolean => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
};

interface AutoReconnectState {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
}

export const useAutoReconnect = create<AutoReconnectState>((set) => ({
  enabled: readPref(),
  setEnabled: (enabled) => {
    try {
      localStorage.setItem(KEY, enabled ? '1' : '0');
    } catch {
      /* storage unavailable — keep it in memory only */
    }
    set({ enabled });
  },
}));
