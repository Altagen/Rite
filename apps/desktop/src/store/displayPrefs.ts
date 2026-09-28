/**
 * Client-side display preferences (localStorage, no backend) — like the terminal
 * theme. These are pure UI toggles that work in every shell/context.
 */

import { create } from 'zustand';

const MEMBER_COUNT_KEY = 'rite.showMemberCount';

interface DisplayPrefs {
  /** Show the member-count number next to shared collections (the users icon stays). */
  showMemberCount: boolean;
  setShowMemberCount: (v: boolean) => void;
}

export const useDisplayPrefs = create<DisplayPrefs>((set) => ({
  showMemberCount: localStorage.getItem(MEMBER_COUNT_KEY) !== 'false', // default on
  setShowMemberCount: (v) => {
    localStorage.setItem(MEMBER_COUNT_KEY, String(v));
    set({ showMemberCount: v });
  },
}));
