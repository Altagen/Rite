/**
 * Client-side machine-status preference (ADR 0017). The server policy is authoritative;
 * a user may only NARROW it locally (e.g. "passive only" even where the server allows active
 * probing), never widen it. Stored per-browser in localStorage; the effective mode is the more
 * restrictive of the server policy and this preference.
 */

import { create } from 'zustand';
import type { HealthcheckPolicy } from '../utils/backend';

// A single collapsed scale (least → most capable). `inherit` = follow the server.
export type HealthPref = 'inherit' | 'off' | 'passive' | 'on-demand' | 'full';
const RANK: Record<Exclude<HealthPref, 'inherit'>, number> = { off: 0, passive: 1, 'on-demand': 2, full: 3 };
const KEY = 'rite.healthPref';

function load(): HealthPref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'off' || v === 'passive' || v === 'on-demand' || v === 'full') return v;
  } catch {
    /* private mode / unavailable */
  }
  return 'inherit';
}

interface HealthPrefStore {
  pref: HealthPref;
  setPref: (p: HealthPref) => void;
}

export const useHealthPref = create<HealthPrefStore>((set) => ({
  pref: load(),
  setPref: (pref) => {
    try {
      if (pref === 'inherit') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, pref);
    } catch {
      /* ignore */
    }
    set({ pref });
  },
}));

/** Collapse the server policy (two axes) to a single scale rank. */
function serverRank(policy: HealthcheckPolicy | undefined): number {
  if (!policy) return RANK.full; // absent ⇒ local vault, user is their own authority
  const active = policy.active;
  if (active === 'on-demand' || active === 'full' || active === 'client-choice') {
    return active === 'on-demand' ? RANK['on-demand'] : RANK.full;
  }
  return policy.passiveStatus !== false ? RANK.passive : RANK.off; // active off → passive or nothing
}

/**
 * The effective machine-status mode: the more restrictive of the server policy and the client
 * preference. Returns whether passive "last seen" shows and whether active probing is available.
 */
export function effectiveHealth(
  policy: HealthcheckPolicy | undefined,
  pref: HealthPref,
): { passive: boolean; activeMode: 'off' | 'on-demand' | 'full' } {
  const server = serverRank(policy);
  const rank = pref === 'inherit' ? server : Math.min(RANK[pref], server);
  return {
    passive: rank >= RANK.passive,
    activeMode: rank >= RANK.full ? 'full' : rank >= RANK['on-demand'] ? 'on-demand' : 'off',
  };
}
