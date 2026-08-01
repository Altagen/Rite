/**
 * Machine status pastille (ADR 0017). Two layers, matching design/mock:
 *  - Active (governed probing): a warm glowing dot when reachable, a calm hollow ring
 *    when there's no response (down is a normal state, NOT an error — never red), an
 *    amber pulse while a check is in flight. Driven by an on-demand "Check".
 *  - Passive ("last seen"): derived from THIS user's own last connection (client-local,
 *    no network traffic) — a soft dot if recent, a hollow ring if it's been a while.
 *
 * An active verdict takes precedence over the passive dot. Passive is shown only when
 * the server keeps it on (always on in a local vault — the user is their own authority).
 */

import { useServerSession } from '../store/serverSessionStore';
import type { HealthStatus } from '../store/healthStore';
import { useHealthPref, effectiveHealth } from '../store/healthPrefStore';

// Recent = within a day → a warmer dot; older → dim; never → hollow.
const RECENT_SECS = 24 * 60 * 60;

function relLabel(seconds: number | null | undefined): string {
  if (!seconds) return 'Never connected';
  const d = Math.floor(Date.now() / 1000) - seconds;
  if (d < 60) return 'Last connected just now';
  if (d < 3600) return `Last connected ${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `Last connected ${Math.floor(d / 3600)}h ago`;
  return `Last connected ${Math.floor(d / 86400)}d ago`;
}

// Kept out of the component render (needs the current time; purity rule).
function dotClass(lastUsedAt: number | null | undefined): string {
  if (lastUsedAt == null) return 'border border-muted-foreground/40'; // never — hollow
  const recent = Math.floor(Date.now() / 1000) - lastUsedAt < RECENT_SECS;
  return recent ? 'bg-emerald-500/80' : 'bg-muted-foreground/50';
}

// The active layer: a reachability verdict (or an in-flight check) beats the passive dot.
export type ActiveState = HealthStatus | 'checking';

export function StatusPastille({
  lastUsedAt,
  active,
  className = '',
}: {
  lastUsedAt: number | null | undefined;
  active?: ActiveState;
  className?: string;
}) {
  const { mode } = useServerSession();
  const healthPref = useHealthPref((s) => s.pref);

  // Active verdict wins when present (an on-demand check has run / is running).
  if (active === 'checking') {
    return (
      <span
        className={`inline-block h-2 w-2 flex-none animate-pulse rounded-full bg-amber-500 ${className}`}
        title="Checking status…"
      />
    );
  }
  if (active === 'up') {
    return (
      <span
        className={`inline-block h-2 w-2 flex-none rounded-full bg-emerald-500 shadow-[0_0_5px_rgba(16,185,129,0.7)] ${className}`}
        title="Reachable · active check"
      />
    );
  }
  if (active === 'down') {
    return (
      <span
        className={`inline-block h-2 w-2 flex-none rounded-full border border-muted-foreground/50 ${className}`}
        title="No response · active check"
      />
    );
  }
  // 'unsupported' (or no active result) → fall through to the passive layer.

  // Effective passive visibility: the more restrictive of the server policy and the client's
  // own narrowing (ADR 0017). Absent policy / local vault ⇒ on unless the user narrows it.
  const { passive } = effectiveHealth(mode?.healthcheck, healthPref);
  if (!passive) return null;

  return (
    <span
      className={`inline-block h-2 w-2 flex-none rounded-full ${dotClass(lastUsedAt)} ${className}`}
      title={`${relLabel(lastUsedAt)} · passive (no probe)`}
    />
  );
}
