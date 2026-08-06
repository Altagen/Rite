/**
 * Access-requests inbox (ADR 0016) — the notifications surface. A bell (with an unread dot)
 * opens a dropdown of pending requests I can grant (I own/edit the collection); granting seals
 * the collection's keys to the requester (a re-seal, exactly like the member picker) and clears
 * the request; dismissing just clears it. The server only ever saw who-asked-for-which — never a
 * key. The dropdown caps the list and links to the full paginated Notifications page (/notifications).
 */

import { useState } from 'react';
import { type IncomingRequest } from '../utils/backend';
import { navigate } from '../store/route';
import { useAccessRequests, type AccessRequestsController } from '../store/accessRequests';

/** How many requests the bell dropdown shows before deferring to the full page. */
const DROPDOWN_CAP = 5;

/** A single request row — the same actions in the dropdown and on the page. */
export function RequestRow({
  r,
  ctl,
  compact = false,
}: {
  r: IncomingRequest;
  ctl: AccessRequestsController;
  compact?: boolean;
}) {
  const k = ctl.keyOf(r);
  return (
    <div className={`flex items-center gap-2.5 ${compact ? 'rounded-md px-2 py-2' : 'px-4 py-3'}`}>
      <span className="grid h-8 w-8 flex-none place-items-center rounded-full bg-primary/15 text-xs font-semibold uppercase text-primary">
        {r.username.slice(0, 2)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">
          <b>{r.username}</b> requests access
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {r.teamName ? `discovered via team ${r.teamName}` : 'access request'}
        </div>
      </div>
      <button
        onClick={() => ctl.dismiss(r)}
        disabled={ctl.busy === k}
        className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
      >
        Dismiss
      </button>
      <button
        onClick={() => ctl.grant(r)}
        disabled={ctl.busy === k}
        className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        Grant
      </button>
    </div>
  );
}

export function AccessRequestsBell() {
  const ctl = useAccessRequests();
  const [open, setOpen] = useState(false);
  const { requests, error } = ctl;
  const shown = requests.slice(0, DROPDOWN_CAP);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="m-btn m-btn-ghost m-btn-sm relative"
        title="Notifications"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0" />
        </svg>
        {requests.length > 0 && (
          <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-amber-500 ring-2 ring-background" />
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-[calc(100%+6px)] z-50 w-[min(92vw,440px)] rounded-xl border border-border bg-card shadow-xl">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div>
                <div className="text-sm font-semibold">Notifications</div>
                <div className="text-xs text-muted-foreground">People asking to join collections you can grant.</div>
              </div>
              {requests.length > 0 && (
                <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-600">
                  {requests.length}
                </span>
              )}
            </div>
            {error && <div className="px-4 pt-3 text-sm text-red-600">{error}</div>}
            <div className="max-h-[60vh] overflow-y-auto p-2">
              {requests.length === 0 ? (
                <div className="py-6 text-center text-sm text-muted-foreground">
                  No pending requests — you&apos;re all caught up.
                </div>
              ) : (
                shown.map((r) => <RequestRow key={ctl.keyOf(r)} r={r} ctl={ctl} compact />)
              )}
            </div>
            {requests.length > 0 && (
              <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
                <span className="text-xs text-muted-foreground">
                  {requests.length > DROPDOWN_CAP ? `Showing latest ${DROPDOWN_CAP} of ${requests.length}` : `${requests.length} total`}
                </span>
                <button
                  onClick={() => {
                    setOpen(false);
                    navigate('/notifications');
                  }}
                  className="rounded-md px-2 py-1 text-xs font-semibold text-primary hover:bg-primary/10"
                >
                  See all notifications →
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
