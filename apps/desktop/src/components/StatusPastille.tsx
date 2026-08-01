/**
 * Passive "last seen" pastille (ADR 0017). A calm dot derived from THIS user's own last
 * connection (client-local, no probing, no network traffic): a soft filled dot if connected
 * recently, a hollow ring if it's been a while / never. Active up/down probing is a later
 * phase; this is the always-free passive signal. Shown only when the server's health-check
 * policy keeps status on (always on in a local vault — the user is their own authority).
 */

import { useServerSession } from '../store/serverSessionStore';

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

export function StatusPastille({ lastUsedAt, className = '' }: { lastUsedAt: number | null | undefined; className?: string }) {
  const { mode } = useServerSession();
  // Server may hide the status UI entirely (passiveStatus=false). Absent ⇒ on. Local vault ⇒ on.
  const show = !mode?.accounts || mode?.healthcheck?.passiveStatus !== false;
  if (!show) return null;

  const cls = dotClass(lastUsedAt);
  return (
    <span
      className={`inline-block h-2 w-2 flex-none rounded-full ${cls} ${className}`}
      title={`${relLabel(lastUsedAt)} · passive (no probe)`}
    />
  );
}
