/**
 * Active health-check results (ADR 0017, active phase). Ephemeral, RAM-only: an
 * on-demand "Check" probes machines through the server (the web UI can't open raw
 * sockets) and we hold the up/down verdicts for this session. The server governs
 * whether probing is allowed at all — a refusal (probing off / not permitted) or a
 * rate-limit surfaces as a calm `notice`, never a crash. Down is a normal verdict,
 * not an error, so the UI paints it calmly (see StatusPastille).
 */

import { create } from 'zustand';
import { Backend, type ProbeTarget } from '../utils/backend';
import { RiteHttpError } from '../utils/httpError';

export type HealthStatus = 'up' | 'down' | 'unsupported';
export type HealthResult = { status: HealthStatus; latencyMs: number | null; checkedAt: number };

interface HealthStore {
  /** Latest verdict per connection id (this session only). */
  results: Record<string, HealthResult>;
  /** Connection ids with a probe currently in flight. */
  checking: Record<string, true>;
  /** Last governance message (probing disabled / rate-limited); cleared on the next check. */
  notice: string | null;
  checkNow: (targets: ProbeTarget[]) => Promise<void>;
  clearNotice: () => void;
}

export const useHealth = create<HealthStore>((set) => ({
  results: {},
  checking: {},
  notice: null,
  checkNow: async (targets) => {
    if (targets.length === 0) return;
    const ids = targets.map((t) => t.id);
    set((s) => ({
      notice: null,
      checking: { ...s.checking, ...Object.fromEntries(ids.map((id) => [id, true as const])) },
    }));
    try {
      const { results } = await Backend.Server.probeHealth(targets);
      const checkedAt = Math.floor(Date.now() / 1000);
      set((s) => {
        const next = { ...s.results };
        for (const r of results) next[r.id] = { status: r.status, latencyMs: r.latencyMs, checkedAt };
        return { results: next };
      });
    } catch (e) {
      // Governance responses aren't failures of the app — degrade with a calm notice.
      const notice =
        e instanceof RiteHttpError
          ? e.status === 403
            ? 'Active status checks are disabled on this server.'
            : e.status === 429
              ? 'Checking too fast — try again in a moment.'
              : 'Could not check machine status.'
          : 'Could not check machine status.';
      set({ notice });
    } finally {
      set((s) => {
        const checking = { ...s.checking };
        for (const id of ids) delete checking[id];
        return { checking };
      });
    }
  },
  clearNotice: () => set({ notice: null }),
}));
