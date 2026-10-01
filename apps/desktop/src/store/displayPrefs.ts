/**
 * Client-side display preferences (localStorage, no backend) — like the terminal
 * theme. These are pure UI toggles that work in every shell/context.
 */

import { create } from 'zustand';

const MEMBER_COUNT_KEY = 'rite.showMemberCount';
const MACHINE_PROBES_KEY = 'rite.machineProbes';

interface DisplayPrefs {
  /** Show the member-count number next to shared collections (the users icon stays). */
  showMemberCount: boolean;
  setShowMemberCount: (v: boolean) => void;
  /**
   * Run the dashboard cards that reach out to a host — containers and services
   * (ADR 0019). Per device on purpose: it is a statement about this machine's
   * network and this person's screen, not an account attribute to sync.
   *
   * Independent of the server policy, and only ever able to restrict it further:
   * off here means off, whatever the server permits.
   */
  machineProbes: boolean;
  setMachineProbes: (v: boolean) => void;
}

export const useDisplayPrefs = create<DisplayPrefs>((set) => ({
  showMemberCount: localStorage.getItem(MEMBER_COUNT_KEY) !== 'false', // default on
  setShowMemberCount: (v) => {
    localStorage.setItem(MEMBER_COUNT_KEY, String(v));
    set({ showMemberCount: v });
  },
  machineProbes: localStorage.getItem(MACHINE_PROBES_KEY) !== 'false', // default on
  setMachineProbes: (v) => {
    localStorage.setItem(MACHINE_PROBES_KEY, String(v));
    set({ machineProbes: v });
  },
}));
