/**
 * Non-blocking connection banner (design/mock/errors.html). Mid-session, a dropped network is
 * a banner over the app — not a full-page takeover — because your work is still there waiting
 * to resume. Driven by the browser's online/offline events; auto-hides when back online.
 */

import { useEffect, useState } from 'react';

export function OfflineBanner() {
  const [offline, setOffline] = useState(() => typeof navigator !== 'undefined' && !navigator.onLine);

  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  if (!offline) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[100] flex justify-center px-4">
      <div className="pointer-events-auto flex items-center gap-3 rounded-xl border border-amber-500/40 bg-card px-4 py-2.5 shadow-xl">
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-muted border-t-amber-500" />
        <div>
          <div className="text-sm font-semibold">You&apos;re offline</div>
          <div className="text-xs text-muted-foreground">
            Reconnecting when you&apos;re back — nothing is lost.
          </div>
        </div>
      </div>
    </div>
  );
}
