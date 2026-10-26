/**
 * Typing in one pane, reaching all of them.
 *
 * SCOPED TO ONE TAB, as tmux's `synchronize-panes` is. Broadcasting into panes in another
 * tab would be typing where nobody is looking, and the blast radius of a MODE is every
 * keystroke rather than one deliberate act — which is why the one-shot broadcast in the
 * snippets list can afford to reach every open pane and this cannot.
 *
 * SAFE BY CONSTRUCTION, not by bookkeeping. `targets` holds the session ids of the
 * broadcasting tab's panes, and a pane fans out only when its OWN session is among them.
 * Switching tabs therefore stops the fan-out with nothing to turn off and nothing to
 * remember: the pane you are now typing in is not in the list. That is the whole guard,
 * and it is one condition rather than a flag someone has to keep in step with the UI.
 *
 * NEVER REMEMBERED. No `deviceStore`, no file: a mode that survived a restart would be a
 * mode waiting to be forgotten, and what it costs to forget is a command running on
 * machines nobody meant to touch.
 */
import { create } from 'zustand';

interface BroadcastState {
  /** The tab whose panes share every keystroke, or null when off. */
  tabId: string | null;
  /**
   * The sessions a keystroke reaches. Republished while the mode is on, so a pane opened
   * mid-broadcast joins and a pane closed drops out — `synchronize-panes` includes new
   * panes too, and a list that went stale would silently stop reaching one of them.
   */
  targets: string[];
  /** Turn it on for `tabId`, or off when it is already on for that tab. */
  toggle: (tabId: string, sessions: string[]) => void;
  /** Keep the target list in step with the tab's tree. No-op while off. */
  retarget: (tabId: string, sessions: string[]) => void;
  off: () => void;
}

export const useBroadcast = create<BroadcastState>((set, get) => ({
  tabId: null,
  targets: [],
  toggle: (tabId, sessions) =>
    set(get().tabId === tabId ? { tabId: null, targets: [] } : { tabId, targets: sessions }),
  retarget: (tabId, sessions) =>
    set((s) => (s.tabId === tabId ? { ...s, targets: sessions } : s)),
  off: () => set({ tabId: null, targets: [] }),
}));

/**
 * Every session one keystroke from `sessionId` should reach.
 *
 * The pane's own session when the mode is off or this pane is not part of it — so a caller
 * sends to whatever comes back and never asks whether broadcasting is on.
 */
export function broadcastTargets(sessionId: string): string[] {
  const { targets } = useBroadcast.getState();
  return targets.includes(sessionId) ? targets : [sessionId];
}
