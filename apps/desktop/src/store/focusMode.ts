/**
 * Focus mode (client/native only, [[rite-feature-focus-mode-shortcuts]]). Runtime `active` state
 * plus a device-local `autoCollapse` preference (whether entering focus also hides the sidebar).
 * The preference is persisted in localStorage — it's a per-device UI choice, not synced to a
 * server or vault. Focus mode itself is gated on isNativeShell() by the callers.
 */
import { create } from 'zustand';

const KEY = 'rite-focus-auto-collapse';
const readPref = (): boolean => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
};

interface FocusModeState {
  active: boolean;
  autoCollapse: boolean;
  setActive: (active: boolean) => void;
  setAutoCollapse: (v: boolean) => void;
}

export const useFocusMode = create<FocusModeState>((set) => ({
  active: false,
  autoCollapse: readPref(),
  setActive: (active) => set({ active }),
  setAutoCollapse: (autoCollapse) => {
    try {
      localStorage.setItem(KEY, autoCollapse ? '1' : '0');
    } catch {
      /* storage unavailable — keep it in memory only */
    }
    set({ autoCollapse });
  },
}));
